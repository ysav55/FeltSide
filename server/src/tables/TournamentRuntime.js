import { TableEngine, EngineError } from '../game/TableEngine.js';
import { rngCardSourceFactory } from '../game/cardSource.js';
import { analyzeHand } from '../analyzers/index.js';
import { computePayouts } from '../tournament/payouts.js';
import { icmEquities, icmDeal } from '../tournament/icm.js';
import { ladderLevel, startingStack } from '../tournament/presets.js';

/**
 * TournamentRuntime — one tournament (TOURNAMENTS.md), autonomous state
 * machine over N internal TableEngine instances. Registered in TableService
 * under its anchor `tables` row id, so the lobby, sockets (enter/act/state)
 * and per-viewer redaction all reuse the existing plumbing.
 *
 * Timers are injectable (tests run a whole tournament in milliseconds):
 *   timers = { levelMs?, breakMs?, tickMs?, actionMs?, interHandMs?,
 *              persistMs?, regAheadMs? }
 */
const DEFAULT_TIMERS = {
  tickMs: 1000,
  interHandMs: 1500,
  persistMs: 30_000,      // RUNTIME §1: clock persisted every 30s
  regAheadMs: 60 * 60_000, // registration opens 1h before scheduled_start
};
const MIN_PLAYERS_AUTO_START = 4;

export class TournamentRuntime {
  constructor({ tableRow, tournamentRow, repos, emit = () => {}, timers = {}, cardSourceFactory = null, settingsProvider = null }) {
    this.tableId = tableRow.id;               // anchor tables row (lobby id)
    this.tournamentId = tournamentRow.id;
    this.mode = 'tournament';
    this.name = tableRow.config?.name ?? tournamentRow.config?.name ?? 'Tournament';
    this.crmEntryId = tableRow.crm_entry_id ?? null;
    this.scheduledStart = tableRow.scheduled_start ?? null;
    this.seatList = Array.isArray(tableRow.config?.seatPlayerIds) ? tableRow.config.seatPlayerIds : [];
    this.openSeating = this.seatList.length === 0;
    this.config = tournamentRow.config;       // preset snapshot (§1)
    this.repos = repos;
    this.emit = emit;
    this.timers = { ...DEFAULT_TIMERS, ...timers };
    this.cardSourceFactory = cardSourceFactory ?? rngCardSourceFactory();
    this.settingsProvider = settingsProvider;

    this.status = tournamentRow.status;       // registering | running | completed
    this.paused = false;
    this.closed = false;
    this.autoBalance = true;
    this.handForHand = false;
    this.sessionId = null;
    this.entries = new Map();                 // playerId → { name, entries, addon, totalPaid, finishPosition, payout }
    this.eliminationOrder = [];               // playerId, earliest bust first
    this.pendingReentry = new Set();          // busted, window open, may re-enter
    this.deal = null;                         // { amounts: Map, accepted: Set }
    this.connected = new Set();
    this.coachViewTable = 1;
    this.tables = new Map();                  // no → { no, engine, idle, chain, timer, nextNo? }
    this._nextTableNo = 1;
    this.clock = {
      level: 1,
      msRemaining: this._levelMs(),
      onBreak: false,
      breakMsRemaining: 0,
    };
    this._tickHandle = null;
    this._lastPersist = 0;
    this._startTimer = null;
    this.endedEarly = false;
  }

  _levelMs() { return this.timers.levelMs ?? this.config.level_duration_min * 60_000; }
  _breakMs() { return this.timers.breakMs ?? (this.config.breaks?.minutes ?? 5) * 60_000; }
  _actionMs() { return this.timers.actionMs ?? (this.config.action_timer_sec ?? 30) * 1000; }

  currentLevelRow() { return ladderLevel(this.config, this.clock.level); }

  _levelBlinds() {
    const row = this.currentLevelRow();
    const anteOn = this.config.ante?.type === 'bb_ante' &&
      this.clock.level >= (this.config.ante.from_level ?? Infinity);
    return { smallBlind: row.sb, bigBlind: row.bb, bbAnte: anteOn ? row.bb_ante || row.bb : 0 };
  }

  // ── Registration & money (§3, §5) ────────────────────────────────────

  _entry(playerId) { return this.entries.get(playerId) ?? null; }

  livePlayers() {
    const live = [];
    for (const t of this.tables.values()) {
      for (const s of t.engine.occupiedSeats()) live.push({ ...s, tableNo: t.no });
    }
    return live;
  }

  liveCount() { return this.livePlayers().length; }

  prizePool() {
    let pool = 0;
    for (const e of this.entries.values()) pool += e.totalPaid;
    return pool;
  }

  fieldSize() {
    let n = 0;
    for (const e of this.entries.values()) n += e.entries;
    return n;
  }

  payoutAmounts() {
    return computePayouts(this.prizePool(), this.fieldSize(), this.entries.size, this.config.payout_table);
  }

  async register(player, { override = false } = {}) {
    if (this.closed || this.status === 'completed') throw new EngineError('tournament_over');
    if (this.entries.has(player.id)) throw new EngineError('already_registered');
    const lateRegOpen = this.status === 'registering' ||
      (this.status === 'running' && this.clock.level <= (this.config.late_reg_until_level ?? 0));
    if (!lateRegOpen && !override) throw new EngineError('registration_closed');
    const allowed = override || this.openSeating || this.seatList.includes(player.id) || player.role === 'coach';
    if (!allowed) throw new EngineError('not_on_seat_list');

    await this.repos.bankrollRepo.applyTransaction({
      playerId: player.id, type: 'tournament_buy_in',
      amount: -this.config.buy_in, refId: this.tournamentId,
    });
    await this.repos.tournamentsRepo.upsertEntry({
      tournamentId: this.tournamentId, playerId: player.id, paid: this.config.buy_in,
    });
    this.entries.set(player.id, {
      name: player.display_name, entries: 1, addon: false,
      totalPaid: this.config.buy_in, finishPosition: null, payout: 0,
    });

    if (this.status === 'running') {
      this._seatLateEntrant(player.id, player.display_name);
      await this._afterBoundary();
    }
    this._broadcast();
    return this.entries.get(player.id);
  }

  /** Re-entry (§1: fresh full stack while the window is open). */
  async reenter(player, { override = false } = {}) {
    const entry = this._entry(player.id);
    if (!entry) throw new EngineError('not_registered');
    if (!this.pendingReentry.has(player.id)) throw new EngineError('not_busted');
    const windowOpen = this.clock.level <= (this.config.reentry?.until_level ?? 0);
    const underMax = entry.entries <= (this.config.reentry?.max ?? 0);
    if (!((windowOpen && underMax) || override)) throw new EngineError('reentry_closed');

    await this.repos.bankrollRepo.applyTransaction({
      playerId: player.id, type: 'tournament_reentry',
      amount: -this.config.buy_in, refId: this.tournamentId,
    });
    await this.repos.tournamentsRepo.upsertEntry({
      tournamentId: this.tournamentId, playerId: player.id, paid: this.config.buy_in,
    });
    entry.entries += 1;
    entry.totalPaid += this.config.buy_in;
    // The prior elimination is voided — they are alive again.
    this.eliminationOrder = this.eliminationOrder.filter((id) => id !== player.id);
    this.pendingReentry.delete(player.id);
    this._seatLateEntrant(player.id, entry.name);
    await this._afterBoundary();
    this._broadcast();
    return entry;
  }

  /** Add-on at the designated break (§1). */
  async addon(player) {
    const entry = this._entry(player.id);
    if (!entry) throw new EngineError('not_registered');
    if (entry.addon) throw new EngineError('addon_taken');
    const cfg = this.config.addon;
    if (!cfg?.allowed) throw new EngineError('addon_unavailable');
    if (!this.clock.onBreak || this.clock.level <= cfg.at_break_after_level) {
      throw new EngineError('addon_window_closed');
    }
    const seat = this._findSeat(player.id);
    if (!seat) throw new EngineError('not_seated');
    const cost = cfg.cost ?? this.config.buy_in;
    await this.repos.bankrollRepo.applyTransaction({
      playerId: player.id, type: 'tournament_addon', amount: -cost, refId: this.tournamentId,
    });
    await this.repos.tournamentsRepo.setAddon(this.tournamentId, player.id, cost);
    entry.addon = true;
    entry.totalPaid += cost;
    seat.seat.stack += cfg.chips;
    this._broadcast();
    return entry;
  }

  _findSeat(playerId) {
    for (const t of this.tables.values()) {
      const seat = t.engine.findSeat(playerId);
      if (seat) return { table: t, seat };
    }
    return null;
  }

  // ── Lifecycle (§3) ───────────────────────────────────────────────────

  /** Arm the auto-start check (scheduled time, ≥ min players). */
  armAutoStart(now = Date.now()) {
    if (!this.scheduledStart || this.status !== 'registering') return;
    const delay = Math.max(0, new Date(this.scheduledStart).getTime() - now);
    clearTimeout(this._startTimer);
    this._startTimer = setTimeout(() => {
      if (this.status === 'registering' && this.entries.size >= MIN_PLAYERS_AUTO_START) {
        this.start().catch(() => {});
      } // otherwise: waits for the coach (§3)
    }, delay);
    if (this._startTimer.unref) this._startTimer.unref();
  }

  async start() {
    if (this.status !== 'registering') throw new EngineError('not_registering');
    if (this.entries.size < 2) throw new EngineError('not_enough_players');
    this.status = 'running';
    clearTimeout(this._startTimer);
    await this.repos.tournamentsRepo.setStatus(this.tournamentId, 'running');
    await this.repos.tablesRepo.setStatus(this.tableId, 'active');
    const session = await this.repos.recordingRepo.openSession({
      tableId: this.tableId, tableMode: 'tournament', crmEntryId: this.crmEntryId,
    });
    this.sessionId = session.id;

    // Initial random draw across the fewest tables that fit the field.
    const size = this.config.table_size;
    const ids = [...this.entries.keys()];
    shuffle(ids);
    const tableCount = Math.max(1, Math.ceil(ids.length / size));
    for (let i = 0; i < tableCount; i++) this._createTable();
    const tableNos = [...this.tables.keys()];
    ids.forEach((playerId, i) => {
      const t = this.tables.get(tableNos[i % tableNos.length]);
      this._seatRandom(t, playerId, this.entries.get(playerId).name, startingStack(this.config));
    });

    this._startClock();
    await this._persist(true);
    this._pump();
    this._broadcast();
  }

  _createTable() {
    const no = this._nextTableNo++;
    const table = {
      no,
      idle: true,
      chain: Promise.resolve(),
      timer: null,
      engine: null,
    };
    table.engine = new TableEngine({
      config: { ...this._levelBlinds(), tableSize: this.config.table_size, tournamentBlinds: true },
      cardSourceFactory: this.cardSourceFactory,
      listener: (event) => this._onEngineEvent(table, event),
    });
    this.tables.set(no, table);
    return table;
  }

  _seatRandom(table, playerId, name, stack) {
    const empty = [];
    table.engine.seats.forEach((s, i) => { if (!s) empty.push(i); });
    const seatIndex = empty[Math.floor(Math.random() * empty.length)];
    table.engine.seatPlayer({ playerId, name, stack, seatIndex });
  }

  _seatLateEntrant(playerId, name) {
    // Smallest table, seat closest behind the BB (§4 move rule reused).
    let target = null;
    for (const t of this.tables.values()) {
      if (!target || t.engine.occupiedSeats().length < target.engine.occupiedSeats().length) target = t;
    }
    if (!target) { target = this._createTable(); }
    const seatIndex = this._seatBehindBB(target);
    target.engine.seatPlayer({ playerId, name, stack: startingStack(this.config), seatIndex });
  }

  /** First empty seat scanning counter-clockwise from the incoming BB. */
  _seatBehindBB(table) {
    const engine = table.engine;
    const n = engine.seats.length;
    const anchor = engine._prevBb ?? 0;
    // The incoming BB is the next occupied seat after anchor; behind it =
    // counter-clockwise from there.
    let bbNext = anchor;
    for (let i = 1; i <= n; i++) {
      const idx = (anchor + i) % n;
      if (engine.seats[idx]) { bbNext = idx; break; }
    }
    for (let i = 1; i <= n; i++) {
      const idx = (bbNext - i + n * 2) % n;
      if (!engine.seats[idx]) return idx;
    }
    throw new EngineError('table_full');
  }

  // ── Clock (§3): levels, breaks, persistence (RUNTIME §1) ─────────────

  _startClock() {
    clearInterval(this._tickHandle);
    // The clock burns REAL elapsed time, not tick counts — under load the
    // interval fires late and a count-based clock would silently freeze.
    this._lastTick = Date.now();
    this._tickHandle = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this._lastTick;
      this._lastTick = now;
      this._tick(elapsed); // paused/break time is discarded inside
    }, this.timers.tickMs);
    if (this._tickHandle.unref) this._tickHandle.unref();
  }

  _tick(elapsed) {
    if (this.paused || this.status !== 'running' || this.closed) return;
    if (this.clock.onBreak) {
      this.clock.breakMsRemaining -= elapsed;
      if (this.clock.breakMsRemaining <= 0) {
        this.clock.onBreak = false;
        this.clock.breakMsRemaining = 0;
        this._pump();
      }
    } else {
      this.clock.msRemaining -= elapsed;
      if (this.clock.msRemaining <= 0) this._advanceLevel();
    }
    this._maybePersist();
    this.emit('tournament_clock', { tableId: this.tableId });
  }

  _advanceLevel() {
    const finished = this.clock.level;
    this.clock.level = Math.min(finished + 1, this.config.blind_ladder.length);
    this.clock.msRemaining = this._levelMs();
    const every = this.config.breaks?.every_n_levels ?? 0;
    if (every > 0 && finished % every === 0) {
      this.clock.onBreak = true;
      this.clock.breakMsRemaining = this._breakMs();
    }
    this._persist(true).catch(() => {});
    this._broadcast();
  }

  async _maybePersist() {
    const now = Date.now();
    if (now - this._lastPersist >= this.timers.persistMs) await this._persist();
  }

  async _persist(force = false) {
    this._lastPersist = Date.now();
    const state = {
      clock: { ...this.clock },
      autoBalance: this.autoBalance,
      handForHand: this.handForHand,
      eliminationOrder: [...this.eliminationOrder],
      pendingReentry: [...this.pendingReentry],
      endedEarly: this.endedEarly,
      nextTableNo: this._nextTableNo,
      tables: [...this.tables.values()].map((t) => ({
        no: t.no,
        button: t.engine.button,
        prevBb: t.engine._prevBb ?? null,
        prevSb: t.engine._prevSb ?? null,
        seats: t.engine.snapshotSeats(),
      })),
    };
    void force;
    await this.repos.tournamentsRepo.saveState(this.tournamentId, state);
  }

  /** Rebuild from a persisted snapshot (RUNTIME §1 recovery). */
  restore(state, entries) {
    for (const e of entries) {
      this.entries.set(e.player_id, {
        name: e.name, entries: e.entries, addon: e.addon,
        totalPaid: Number(e.total_paid),
        finishPosition: e.finish_position, payout: Number(e.payout),
      });
    }
    if (!state || !state.clock) return;
    this.clock = { ...state.clock };
    this.autoBalance = state.autoBalance ?? true;
    this.handForHand = state.handForHand ?? false;
    this.eliminationOrder = state.eliminationOrder ?? [];
    this.pendingReentry = new Set(state.pendingReentry ?? []);
    this.endedEarly = state.endedEarly ?? false;
    this._nextTableNo = state.nextTableNo ?? 1;
    for (const t of state.tables ?? []) {
      const table = this._createTable();
      this.tables.delete(table.no);
      table.no = t.no;
      this.tables.set(t.no, table);
      table.engine.restoreSeats(t.seats, { button: t.button, prevBb: t.prevBb, prevSb: t.prevSb });
    }
    this._nextTableNo = Math.max(this._nextTableNo, ...[...this.tables.keys()].map((n) => n + 1), 1);
  }

  resumeAfterRestore() {
    if (this.status === 'running') {
      this._startClock();
      this._pump();
    } else if (this.status === 'registering') {
      this.armAutoStart();
    }
  }

  // ── Hand loop, eliminations, boundary work ───────────────────────────

  _onEngineEvent(table, event) {
    if (event.type === 'awaiting_action') {
      this._armActionTimer(table, event.playerId);
      this.emit('awaiting_action', { tableId: this.tableId, tableNo: table.no, ...event });
    }
    if (event.type === 'hand_complete') {
      clearTimeout(table.timer);
      // Busts apply SYNCHRONOUSLY at hand completion. Boundary work for
      // OTHER tables can run before this table's async chain does — if
      // stack-0 seats lingered until then, balancing would count them as
      // live players (and could even move one to another table).
      this._applyBusts(table, event.record);
      table.chain = table.chain
        .then(() => this._afterHand(table, event.record))
        .catch(() => {});
    }
  }

  /**
   * Eliminations (§3): stack 0 at hand completion. Simultaneous busts:
   * the bigger hand-start stack finishes higher → push in ascending
   * stack-start order (finish ranking reads the list back to front).
   */
  _applyBusts(table, record) {
    const busted = record.participants
      .filter((p) => {
        const seat = table.engine.findSeat(p.playerId);
        return seat && seat.stack === 0;
      })
      .sort((a, b) => a.stackStart - b.stackStart);
    for (const p of busted) {
      const seat = table.engine.findSeat(p.playerId);
      table.engine.seats[seat.seatIndex] = null; // hand is over — sync release
      this.eliminationOrder.push(p.playerId);
      const entry = this._entry(p.playerId);
      const windowOpen = this.clock.level <= (this.config.reentry?.until_level ?? 0);
      const underMax = this.config.reentry?.allowed && entry.entries <= (this.config.reentry.max ?? 0);
      if (windowOpen && underMax) this.pendingReentry.add(p.playerId);
      this.emit('elimination', { tableId: this.tableId, playerId: p.playerId });
    }
  }

  /** §8 absence: blinds post in absentia; the timer auto-folds. Always armed. */
  _armActionTimer(table, playerId) {
    clearTimeout(table.timer);
    if (this.paused) return; // re-armed on resume
    table.deadline = Date.now() + this._actionMs();
    table.timer = setTimeout(() => {
      table.chain = table.chain
        .then(() => table.engine.autoAct(playerId))
        .then(() => this._broadcast())
        .catch(() => {});
    }, this._actionMs());
    if (table.timer.unref) table.timer.unref();
  }

  async _afterHand(table, record) {
    table.idle = true;
    // Record into the single tournament session; analyzers fire (all origins).
    // A recording failure must never kill the game loop — the tournament
    // plays on and the error is surfaced, not swallowed.
    try {
      const settings = this.settingsProvider ? await this.settingsProvider() : undefined;
      const tags = analyzeHand(record, { settings });
      await this.repos.recordingRepo.recordHand(this.sessionId, record, tags);
    } catch (err) {
      console.error(`tournament ${this.tournamentId}: hand recording failed`, err);
    }
    // (Busts were already applied synchronously in _applyBusts.)
    await this._afterBoundary();
    await this._persist();
    this._broadcast();
    this._pump();
  }

  /** Between-hands work: completion check, hand-for-hand, balance, break. */
  async _afterBoundary() {
    if (this.status !== 'running') return;
    const live = this.liveCount();
    if (live <= 1) return this._complete();

    // Hand-for-hand (§3): engages when ONE elimination reaches the money.
    const paidPlaces = this.payoutAmounts().length;
    this.handForHand = live === paidPlaces + 1;

    this._breakOrBalance();
  }

  /** A break/final-redraw is due — hold new hand starts until it happens. */
  _structureChangeDue() {
    const activeTables = [...this.tables.values()].filter((t) => t.engine.occupiedSeats().length > 0);
    if (activeTables.length <= 1) return false;
    return this.liveCount() <= (activeTables.length - 1) * this.config.table_size;
  }

  /**
   * Moves happen between hands only (§4): a table mid-hand defers its part
   * of the work to its own next boundary — _afterHand re-invokes this after
   * every completed hand, and _pump holds starts while a break is due.
   */
  _breakOrBalance() {
    if (this.status !== 'running') return;
    const size = this.config.table_size;
    const live = this.liveCount();
    const activeTables = [...this.tables.values()].filter((t) => t.engine.occupiedSeats().length > 0);

    // Final table (§4): full random redraw onto one table (all seats move —
    // needs every table between hands).
    if (activeTables.length > 1 && live <= size) {
      if (activeTables.some((t) => t.engine.isHandRunning())) return;
      const players = this.livePlayers();
      for (const t of this.tables.values()) clearTimeout(t.timer);
      for (const t of [...this.tables.keys()]) this.tables.delete(t);
      const final = this._createTable();
      shuffle(players);
      for (const p of players) this._seatRandom(final, p.playerId, p.name, p.stack);
      this.emit('final_table', { tableId: this.tableId });
      return;
    }

    // Breaking (§4): field fits in one fewer table → break the last-created
    // table; its players get a full random draw across the rest. Only the
    // breaking table must be between hands; destinations may be mid-hand
    // (the mover simply joins their next hand).
    if (activeTables.length > 1 && live <= (activeTables.length - 1) * size) {
      const breaking = activeTables.reduce((a, b) => (a.no > b.no ? a : b));
      if (breaking.engine.isHandRunning()) return;
      const movers = breaking.engine.occupiedSeats().map((s) => ({ ...s }));
      for (const s of movers) breaking.engine.seats[s.seatIndex] = null;
      this.tables.delete(breaking.no);
      clearTimeout(breaking.timer);
      shuffle(movers);
      const rest = [...this.tables.values()];
      for (const p of movers) {
        const target = rest
          .filter((t) => t.engine.occupiedSeats().length < size)
          .sort((a, b) => a.engine.occupiedSeats().length - b.engine.occupiedSeats().length)[0];
        this._seatRandom(target, p.playerId, p.name, p.stack);
      }
      this.emit('table_break', { tableId: this.tableId, broke: breaking.no });
      // fall through: a break can still leave a ≥2 imbalance
    }

    // Auto-balance (§4): ≥2 gap → BB-due player from largest moves to the
    // seat closest behind the BB at the smallest. Stack-agnostic. The source
    // must be between hands (the mover may be in a live hand otherwise).
    if (!this.autoBalance) return;
    for (;;) {
      const tables = [...this.tables.values()].filter((t) => t.engine.occupiedSeats().length > 0);
      if (tables.length < 2) return;
      tables.sort((a, b) => a.engine.occupiedSeats().length - b.engine.occupiedSeats().length);
      const smallest = tables[0];
      const largest = tables[tables.length - 1];
      const gap = largest.engine.occupiedSeats().length - smallest.engine.occupiedSeats().length;
      if (gap < 2) return;
      if (largest.engine.isHandRunning()) return; // its own boundary retries
      const mover = this._bbDueSeat(largest);
      this._movePlayer(mover.playerId, smallest.no, this._seatBehindBB(smallest));
    }
  }

  /** The player due BB next at a table (dead-button progression). */
  _bbDueSeat(table) {
    const engine = table.engine;
    const n = engine.seats.length;
    const anchor = engine._prevBb ?? -1;
    for (let i = 1; i <= n; i++) {
      const idx = ((anchor < 0 ? 0 : anchor) + i) % n;
      const s = engine.seats[idx];
      if (s) return s;
    }
    return engine.occupiedSeats()[0];
  }

  _movePlayer(playerId, destNo, seatIndex) {
    const from = this._findSeat(playerId);
    if (!from) throw new EngineError('not_seated');
    if (from.table.engine.isHandRunning()) throw new EngineError('hand_in_progress');
    const dest = this.tables.get(destNo);
    if (!dest) throw new EngineError('table_not_found');
    if (dest.engine.seats[seatIndex]) throw new EngineError('seat_taken');
    const { playerId: id, name, stack } = from.seat;
    from.table.engine.seats[from.seat.seatIndex] = null;
    dest.engine.seatPlayer({ playerId: id, name, stack, seatIndex });
    this.emit('player_moved', { tableId: this.tableId, playerId, to: destNo });
  }

  /** Start hands wherever allowed; hand-for-hand synchronizes starts (§3). */
  _pump() {
    if (this.status !== 'running' || this.paused || this.closed) return;
    if (this.clock.onBreak) return;
    if (this._structureChangeDue()) return; // break/redraw first (§4)
    const startable = [...this.tables.values()].filter(
      (t) => t.idle && t.engine.canStartHand()
    );
    if (this.handForHand) {
      const anyRunning = [...this.tables.values()].some((t) => t.engine.isHandRunning());
      if (anyRunning) return; // wait for every table, then start together
    }
    for (const table of startable) {
      table.idle = false;
      setTimeout(() => {
        table.chain = table.chain.then(async () => {
          if (this.status !== 'running' || this.paused || this.closed) { table.idle = true; return; }
          if (this.clock.onBreak || !table.engine.canStartHand()) { table.idle = true; return; }
          if (this._structureChangeDue() || !this.tables.has(table.no)) { table.idle = true; return; }
          table.engine.setLevelBlinds(this._levelBlinds());
          await table.engine.startHand();
          this._broadcast();
        }).catch(() => { table.idle = true; });
      }, this.timers.interHandMs);
    }
  }

  // ── Completion, payouts (§5), deals (§7), end-early (§6) ─────────────

  /** Finish positions: winner(s)/live by stacks, then reverse bust order. */
  _finishRanking() {
    const live = this.livePlayers().sort((a, b) => b.stack - a.stack);
    const ranked = live.map((s) => s.playerId);
    for (let i = this.eliminationOrder.length - 1; i >= 0; i--) {
      ranked.push(this.eliminationOrder[i]);
    }
    return ranked; // best finish first
  }

  async _complete({ customAmounts = null } = {}) {
    if (this.status === 'completed') return;
    this.status = 'completed';
    clearInterval(this._tickHandle);
    clearTimeout(this._startTimer);
    for (const t of this.tables.values()) clearTimeout(t.timer);

    const ranked = this._finishRanking();
    const amounts = customAmounts ?? this.payoutAmounts();
    for (let i = 0; i < ranked.length; i++) {
      const playerId = ranked[i];
      const entry = this._entry(playerId);
      entry.finishPosition = i + 1;
      await this.repos.tournamentsRepo.setFinish(this.tournamentId, playerId, i + 1);
      const payout = customAmounts ? (customAmounts.get?.(playerId) ?? 0) : (amounts[i] ?? 0);
      if (payout > 0) {
        entry.payout = payout;
        await this.repos.tournamentsRepo.setPayout(this.tournamentId, playerId, payout);
        await this.repos.bankrollRepo.applyTransaction({
          playerId, type: 'tournament_payout', amount: payout, refId: this.tournamentId,
        });
      }
    }

    await this.repos.tournamentsRepo.setStatus(this.tournamentId, 'completed');
    await this.repos.tablesRepo.setStatus(this.tableId, 'completed');
    if (this.sessionId) await this.repos.recordingRepo.finalizeSession(this.sessionId);
    await this._persist(true);
    this.emit('tournament_complete', { tableId: this.tableId });
    this._broadcast();
  }

  /** §6 end-early: stop now, pay by current chip-count ranking. */
  async endEarly() {
    if (this.status !== 'running') throw new EngineError('not_running');
    if ([...this.tables.values()].some((t) => t.engine.isHandRunning())) {
      throw new EngineError('hand_in_progress');
    }
    this.endedEarly = true;
    await this._complete();
  }

  /** §7 deal proposal at the final table; unanimous accept → ICM payouts. */
  proposeDeal() {
    if (!this.config.deals_enabled) throw new EngineError('deals_disabled');
    if (this.status !== 'running') throw new EngineError('not_running');
    const activeTables = [...this.tables.values()].filter((t) => t.engine.occupiedSeats().length > 0);
    if (activeTables.length !== 1) throw new EngineError('not_final_table');
    if (activeTables[0].engine.isHandRunning()) throw new EngineError('hand_in_progress');

    const live = this.livePlayers();
    const amounts = this.payoutAmounts();
    const liveShare = amounts.slice(0, live.length); // places the live players occupy
    const dealAmounts = icmDeal(live.map((s) => s.stack), liveShare);
    this.deal = {
      amounts: new Map(live.map((s, i) => [s.playerId, dealAmounts[i]])),
      accepted: new Set(),
    };
    this._broadcast();
    return this.dealView();
  }

  cancelDeal() { this.deal = null; this._broadcast(); }

  async acceptDeal(playerId) {
    if (!this.deal) throw new EngineError('no_deal');
    if (!this.deal.amounts.has(playerId)) throw new EngineError('not_in_deal');
    this.deal.accepted.add(playerId);
    if (this.deal.accepted.size === this.deal.amounts.size) {
      // Unanimous: live players take ICM amounts; eliminated ITM finishers
      // keep their standard-table amounts (positions after the live field).
      const standard = this.payoutAmounts();
      const custom = new Map(this.deal.amounts);
      const ranked = this._finishRanking();
      for (let i = this.deal.amounts.size; i < standard.length && i < ranked.length; i++) {
        custom.set(ranked[i], standard[i]);
      }
      this.deal = null;
      await this._complete({ customAmounts: custom });
      return { completed: true };
    }
    this._broadcast();
    return { accepted: [...this.deal.accepted] };
  }

  dealView() {
    if (!this.deal) return null;
    return {
      amounts: Object.fromEntries(this.deal.amounts),
      accepted: [...this.deal.accepted],
    };
  }

  // ── Coach interventions (§6) ─────────────────────────────────────────

  pause(paused) {
    this.paused = Boolean(paused);
    if (this.paused) {
      for (const t of this.tables.values()) clearTimeout(t.timer); // freeze action timers
    } else {
      for (const t of this.tables.values()) {
        const engine = t.engine;
        if (engine.isHandRunning() && engine.toAct !== null) {
          this._armActionTimer(t, engine.seats[engine.toAct].playerId);
        }
      }
      this._pump();
    }
    this._broadcast();
  }

  advanceLevel() { this._advanceLevel(); }

  extendLevel(ms) {
    this.clock.msRemaining += ms;
    this._broadcast();
  }

  setAutoBalance(on) {
    this.autoBalance = Boolean(on);
    if (on) this._breakOrBalance();
    this._broadcast();
  }

  coachMove(playerId, tableNo, seatIndex) {
    this._movePlayer(playerId, tableNo, seatIndex);
    this._broadcast();
    this._pump();
  }

  /** Manual eliminate (§6 — no-show cleanup). Chips are removed from play. */
  async coachEliminate(playerId) {
    const found = this._findSeat(playerId);
    if (!found) throw new EngineError('not_seated');
    if (found.table.engine.isHandRunning()) throw new EngineError('hand_in_progress');
    found.table.engine.seats[found.seat.seatIndex] = null;
    this.eliminationOrder.push(playerId);
    this.pendingReentry.delete(playerId);
    await this._afterBoundary();
    await this._persist();
    this._broadcast();
    this._pump();
  }

  setViewTable(no) {
    if (!this.tables.has(no)) throw new EngineError('table_not_found');
    this.coachViewTable = no;
    this._broadcast();
  }

  // ── Socket-facing surface (mirrors the other runtimes) ───────────────

  async act(playerId, action) {
    if (this.paused) throw new EngineError('paused');
    const found = this._findSeat(playerId);
    if (!found) throw new EngineError('not_seated');
    const table = found.table;
    return new Promise((resolve, reject) => {
      table.chain = table.chain
        .then(() => table.engine.act(playerId, action))
        .then(() => { this._broadcast(); resolve(); })
        .catch((err) => { reject(err); });
      table.chain = table.chain.catch(() => {});
    });
  }

  async join() { throw new EngineError('use_registration'); }
  async leave() { throw new EngineError('tournament_seat_never_vacated'); } // §8

  /** Room membership: registered players belong until the tournament ends. */
  hasPlayer(playerId) {
    return this.status !== 'completed' && this.entries.has(playerId);
  }

  playerConnected(playerId) { this.connected.add(playerId); this._broadcast(); }
  playerDisconnected(playerId) { this.connected.delete(playerId); } // §8: nothing else

  stop() {
    clearInterval(this._tickHandle);
    clearTimeout(this._startTimer);
    for (const t of this.tables.values()) clearTimeout(t.timer);
  }

  /** RUNTIME §3: only End Early short-circuits a running tournament. */
  async close() {
    if (this.status === 'running') return this.endEarly();
    if (this.status === 'registering') {
      // Cancelled before start: closed economy — every chip paid returns.
      this.closed = true;
      this.stop();
      for (const [playerId, e] of this.entries) {
        if (e.totalPaid > 0) {
          await this.repos.bankrollRepo.applyTransaction({
            playerId, type: 'tournament_payout', amount: e.totalPaid, refId: this.tournamentId,
          });
          await this.repos.tournamentsRepo.setPayout(this.tournamentId, playerId, e.totalPaid);
        }
      }
      await this.repos.tournamentsRepo.setStatus(this.tournamentId, 'completed');
      await this.repos.tablesRepo.setStatus(this.tableId, 'completed');
      this.emit('table_closed', { tableId: this.tableId, reason: 'cancelled' });
    }
  }

  _standings() {
    const live = this.livePlayers().sort((a, b) => b.stack - a.stack);
    const out = live.map((s, i) => ({
      playerId: s.playerId, name: s.name, stack: s.stack,
      rank: i + 1, tableNo: s.tableNo, eliminated: false,
    }));
    const liveCount = live.length;
    for (let i = this.eliminationOrder.length - 1; i >= 0; i--) {
      const playerId = this.eliminationOrder[i];
      out.push({
        playerId, name: this._entry(playerId)?.name ?? '?', stack: 0,
        rank: liveCount + (this.eliminationOrder.length - i), eliminated: true,
        pendingReentry: this.pendingReentry.has(playerId),
      });
    }
    return out;
  }

  _icmOverlay() {
    if (!this.config.icm_overlay || this.status !== 'running') return null;
    const live = this.livePlayers();
    if (live.length === 0 || live.length > 20) return null; // tractable + meaningful
    const amounts = this.payoutAmounts();
    const ev = icmEquities(live.map((s) => s.stack), amounts.slice(0, live.length));
    return Object.fromEntries(live.map((s, i) => [s.playerId, Math.round(ev[i])]));
  }

  tournamentView(viewerId) {
    const blinds = this._levelBlinds();
    const live = this.livePlayers();
    const entry = this._entry(viewerId);
    return {
      status: this.status,
      paused: this.paused,
      level: this.clock.level,
      smallBlind: blinds.smallBlind,
      bigBlind: blinds.bigBlind,
      ante: blinds.bbAnte,
      msRemaining: this.clock.onBreak ? this.clock.breakMsRemaining : this.clock.msRemaining,
      onBreak: this.clock.onBreak,
      playersLeft: live.length,
      entrants: this.entries.size,
      fieldSize: this.fieldSize(),
      avgStack: live.length ? Math.round(live.reduce((n, s) => n + s.stack, 0) / live.length) : 0,
      prizePool: this.prizePool(),
      payouts: this.payoutAmounts(),
      handForHand: this.handForHand,
      scheduledStart: this.scheduledStart,
      registered: [...this.entries.values()].map((e) => e.name),
      standings: this._standings(),
      icm: this._icmOverlay(),
      deal: this.dealView(),
      myEntry: entry ? {
        registered: true,
        entries: entry.entries,
        addon: entry.addon,
        finishPosition: entry.finishPosition,
        payout: entry.payout,
        canReenter: this.pendingReentry.has(viewerId),
        canAddon: Boolean(this.config.addon?.allowed) && !entry.addon && this.clock.onBreak,
      } : { registered: false },
    };
  }

  publicState(viewerId) {
    const found = this._findSeat(viewerId);
    const table = found?.table ??
      (this.tables.get(this.coachViewTable) ?? [...this.tables.values()][0] ?? null);
    const state = table ? table.engine.getPublicState(viewerId) : {
      phase: 'waiting', handNo: 0, board: [], pot: 0, currentBet: 0,
      button: null, toAct: null,
      config: { ...this._levelBlinds(), tableSize: this.config.table_size },
      seats: [],
    };
    return {
      tableId: this.tableId,
      mode: 'tournament',
      name: this.name,
      status: this.status === 'registering' ? 'open' : this.status === 'running' ? 'active' : 'completed',
      paused: this.paused,
      awaitingDeal: false,
      connected: [...this.connected],
      actionDeadline: table && table.deadline && table.engine.toAct !== null ? table.deadline : null,
      tournament: this.tournamentView(viewerId),
      viewingTableNo: table?.no ?? null,
      ...state,
    };
  }

  coachState() {
    return {
      tableId: this.tableId,
      tournamentId: this.tournamentId,
      viewTable: this.coachViewTable,
      autoBalance: this.autoBalance,
      paused: this.paused,
      tables: [...this.tables.values()].map((t) => ({
        no: t.no,
        players: t.engine.occupiedSeats().length,
        handRunning: t.engine.isHandRunning(),
        seats: t.engine.snapshotSeats(),
      })),
    };
  }

  _broadcast() {
    this.emit('state', { tableId: this.tableId });
    // Coach panel (table sizes, hand states) rides the same beat; the
    // socket layer only delivers it to coach-role sockets.
    this.emit('coach_state', { tableId: this.tableId });
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
