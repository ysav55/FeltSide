import { TableEngine, EngineError } from '../game/TableEngine.js';
import { createCoachedSource } from '../game/coachedCardSource.js';
import { analyzeHand } from '../analyzers/index.js';
import { buildReplay } from '../game/ReplayEngine.js';

/**
 * CoachedTableRuntime — one live coached table (PRD §3.1, DEALING.md).
 *
 * Differences from the uncoached runtime: no bankroll (coach-set stacks),
 * no action timer by default (optional per table), no automatic hand loop
 * (the coach deals), no disconnect penalties (the coach owns the room),
 * pause/undo/rollback/force/award controls, the dealing panel, live coach
 * tagging, scenario/playlist drills.
 *
 * Visibility (non-negotiable, enforced HERE server-side): the shared view
 * never contains another player's hole cards; the coach view contains ONLY
 * coach-assigned cards and range draws — pure-RNG cards stay hidden from
 * the coach even when he is seated (his own hand excepted).
 */

const EMPTY_PANEL = () => ({
  slots: {},
  board: [null, null, null, null, null],
  streetPolicy: { flop: 'auto', turn: 'auto', river: 'auto' },
  fromScenario: false,
});

export class CoachedTableRuntime {
  constructor({ tableRow, repos, emit = () => {}, timers = {}, coachPlayerId = null, settingsProvider = null }) {
    this.tableId = tableRow.id;
    this.mode = 'coached_cash';
    this.config = tableRow.config || {};
    this.crmEntryId = tableRow.crm_entry_id ?? null;
    this.scheduledEnd = tableRow.scheduled_end ?? null;
    this.status = 'open';
    this.repos = repos;
    this.emit = emit;
    this.timers = timers; // { emptyCloseMs? } — injectable for tests
    this.coachPlayerId = coachPlayerId;
    this.settingsProvider = settingsProvider; // () => analyzer settings snapshot
    this.sessionId = null;
    this.closed = false;
    this.paused = false;
    this.panel = EMPTY_PANEL();
    this.awaiting = null;          // { street, indices, filled } during awaiting_deal
    this.pendingTags = [];         // live coach tags for the hand in progress
    this.lastHandId = null;
    this.assignedVisible = {};     // coach-visible cards for the CURRENT hand
    this.drill = null;             // { playlistId, name, scenarios, index }
    this.openSeating = false;      // coach override of the soft seat list
    this.connected = new Set();
    this.groupReview = null;       // { hand, cursor } — group transition (M6 §6)
    this._branch = null;           // { handId, cursor, seatStacks } — branch (M6 §5)
    this._chain = Promise.resolve();
    this._source = null;

    this.engine = new TableEngine({
      config: {
        smallBlind: this.config.smallBlind ?? 50,
        bigBlind: this.config.bigBlind ?? 100,
        tableSize: this.config.tableSize ?? 9,
      },
      cardSourceFactory: () => this._createSource(),
      listener: (event) => this._onEngineEvent(event),
    });

    this._armEmptyClose();
  }

  _enqueue(fn) {
    const next = this._chain.then(fn, fn);
    this._chain = next.catch(() => {});
    return next;
  }

  defaultStack() {
    return this.config.defaultStack ?? 100 * this.engine.config.bigBlind;
  }

  // ── Seating (soft restriction, PRD §7) ───────────────────────────────

  seatList() {
    return Array.isArray(this.config.seatPlayerIds) ? this.config.seatPlayerIds : [];
  }

  async join({ player, seatIndex = null }) {
    return this._enqueue(async () => {
      if (this.closed) throw new EngineError('table_closed');
      const list = this.seatList();
      const allowed =
        player.role === 'coach' ||
        this.openSeating ||
        list.length === 0 ||
        list.includes(player.id);
      if (!allowed) throw new EngineError('not_on_seat_list');
      const seat = this.engine.seatPlayer({
        playerId: player.id, name: player.display_name,
        stack: this.defaultStack(), seatIndex,
      });
      await this._persistSeats();
      this._broadcast();
      return seat;
    });
  }

  /** Coach seats any existing player from the table (the override). */
  async coachSeat({ player, seatIndex = null, stack = null }) {
    return this._enqueue(async () => {
      if (this.closed) throw new EngineError('table_closed');
      const seat = this.engine.seatPlayer({
        playerId: player.id, name: player.display_name,
        stack: stack ?? this.defaultStack(), seatIndex,
      });
      await this._persistSeats();
      this._broadcast();
      return seat;
    });
  }

  async leave(playerId) {
    return this._enqueue(async () => {
      const seat = this.engine.findSeat(playerId);
      if (!seat) throw new EngineError('not_seated');
      await this.engine.unseat(playerId);
      if (!this.engine.isHandRunning()) await this._persistSeats();
      this._broadcast();
      return seat.stack; // play chips — nothing banks (RUNTIME §5 scope)
    });
  }

  setOpenSeating(open) {
    this.openSeating = Boolean(open);
    this._broadcast();
  }

  // ── Dealing (DEALING.md) ─────────────────────────────────────────────

  _createSource() {
    this._source = createCoachedSource(this.panel, {
      onAwaiting: (info) => {
        this.awaiting = info;
        this._broadcast(); // players see the neutral "dealer is acting" state
        this.emit('coach_awaiting_deal', { tableId: this.tableId, ...info });
      },
    });
    return this._source;
  }

  /**
   * Panel input validation: format + central duplicate rejection (§1.3).
   * `except` lets the slot/board cell being EDITED exclude its own current
   * cards from the duplicate check — otherwise changing one card of a
   * two-card hole (Ah Kd → Ah Ks) would falsely collide with the stale Ah
   * still sitting in the same slot (M8.6 DEALING F3 fix).
   */
  _validateCard(card, except = {}) {
    if (!/^[2-9TJQKA][hdcs]$/.test(card ?? '')) throw new EngineError('invalid_card');
    // Against other panel-assigned cards (excluding the slot under edit)…
    const assigned = [
      ...Object.entries(this.panel.slots)
        .filter(([pid]) => pid !== except.slotPlayerId)
        .flatMap(([, s]) => (s.mode === 'cards' ? s.cards ?? [] : [])),
      ...this.panel.board.filter((_, i) => i !== except.boardIndex),
    ].filter(Boolean);
    if (assigned.includes(card)) throw new EngineError('duplicate_card');
    // …and against cards already drawn in a live hand.
    if (this._source && this.engine.isHandRunning() && this._source.isUsed(card)) {
      throw new EngineError('duplicate_card');
    }
  }

  setHoleSlot(playerId, slot) {
    if (slot === null) { delete this.panel.slots[playerId]; this._coachBroadcast(); return; }
    if (slot.mode === 'cards') {
      const cards = [slot.cards?.[0] ?? null, slot.cards?.[1] ?? null];
      for (const c of cards) if (c) this._validateCard(c, { slotPlayerId: playerId });
      if (cards[0] && cards[1] && cards[0] === cards[1]) throw new EngineError('duplicate_card');
      this.panel.slots[playerId] = { mode: 'cards', cards };
    } else if (slot.mode === 'range') {
      this.panel.slots[playerId] = { mode: 'range', range: String(slot.range ?? '') };
    } else {
      throw new EngineError('invalid_slot');
    }
    this.panel.fromScenario = false;
    this._coachBroadcast();
  }

  setBoardSlot(index, card) {
    if (!Number.isInteger(index) || index < 0 || index > 4) throw new EngineError('invalid_slot');
    if (card !== null) this._validateCard(card, { boardIndex: index });
    this.panel.board[index] = card;
    this.panel.fromScenario = false;
    this._coachBroadcast();
  }

  setStreetPolicy(street, policy) {
    if (!['flop', 'turn', 'river'].includes(street)) throw new EngineError('invalid_slot');
    if (!['auto', 'manual', 'rng'].includes(policy)) throw new EngineError('invalid_slot');
    this.panel.streetPolicy[street] = policy;
    this._coachBroadcast();
  }

  /** Deal the next hand from the current panel. */
  async deal() {
    return this._enqueue(async () => {
      if (this.closed) throw new EngineError('table_closed');
      if (this.paused) throw new EngineError('paused');
      if (!this.engine.canStartHand()) throw new EngineError('cannot_start');
      await this._activateIfNeeded();
      this.pendingTags = [];
      // §6 non-retroactivity: the analyzer settings snapshot is taken at
      // DEAL time — a change mid-hand applies from the next hand only.
      this._handSettings = this.settingsProvider ? await this.settingsProvider() : undefined;
      // startHand resolves after hole cards; an all-in runout with a manual
      // street may park it on the coach — visibility is captured at the
      // hand_started event, so the panel is correct either way.
      await this.engine.startHand();
      this._broadcast();
      this._coachBroadcast();
    });
  }

  /** Re-deal (§4): exact cards repeat, range slots re-draw, RNG re-randomizes. */
  async redeal() {
    return this.deal(); // the panel IS the config; a fresh source re-reads it
  }

  _captureAssignedVisibility() {
    const visible = {};
    for (const [playerId, slot] of Object.entries(this.panel.slots)) {
      const seat = this.engine.findSeat(playerId);
      if (!seat || !seat.inHand) continue;
      if (slot.mode === 'cards') {
        const typed = (slot.cards ?? []).filter(Boolean);
        if (typed.length) visible[playerId] = typed;
      } else if (slot.mode === 'range') {
        // §2.3: the drawn hand appears in the sidebar.
        visible[playerId] = seat.holeCards ? [...seat.holeCards] : [];
      }
    }
    this.assignedVisible = visible;
  }

  /**
   * Coach filled the pending street slots → release the hand.
   *
   * DELIBERATELY NOT ENQUEUED: during awaiting_deal the blocked act() is
   * still holding the serialization chain (it awaits the street promise).
   * provide/rngRest are the only commands that can resolve that promise —
   * queuing them behind the act would deadlock the table. Both are
   * synchronous up to the resolve, so they are safe outside the chain.
   */
  async provideStreet(cards) {
    if (!this.awaiting || !this._source?.pending) throw new EngineError('nothing_pending');
    if (Array.isArray(cards)) {
      const { street } = this._source.pending;
      const indices = { flop: [0, 1, 2], turn: [3], river: [4] }[street];
      const empty = indices.filter((i) => !this.panel.board[i]);
      if (cards.length !== empty.length) throw new EngineError('invalid_slot');
      for (const c of cards) this._validateCard(c);
      empty.forEach((i, k) => { this.panel.board[i] = cards[k]; });
    }
    this.awaiting = null;
    this._source.provideStreet();
    await this._settle();
    this._broadcast();
    this._coachBroadcast();
  }

  /** One-key escape hatch (§3). Chain-bypassing for the same reason. */
  async rngRest() {
    if (!this.awaiting || !this._source?.pending) throw new EngineError('nothing_pending');
    this.awaiting = null;
    this._source.rngRest();
    await this._settle();
    this._broadcast();
    this._coachBroadcast();
  }

  /** Let a resolved street's async continuation run before returning. */
  async _settle() {
    await new Promise((r) => setImmediate(r));
  }

  // ── Coach controls ───────────────────────────────────────────────────

  pause(paused) {
    this.paused = Boolean(paused);
    this._broadcast();
  }

  /**
   * Awaiting-deal guards run SYNCHRONOUSLY, before enqueueing: while an
   * act() is parked on a pending street it holds the chain, so an enqueued
   * guard would hang instead of erroring.
   */
  _guardNotAwaiting() {
    if (this.awaiting) throw new EngineError('awaiting_deal');
  }

  async act(playerId, action) {
    this._guardNotAwaiting();
    if (this.paused) throw new EngineError('paused');
    return this._enqueue(async () => {
      if (this.paused) throw new EngineError('paused');
      await this.engine.act(playerId, action);
      this._broadcast();
    });
  }

  async undo() {
    this._guardNotAwaiting();
    return this._enqueue(async () => {
      this.engine.undoLastAction();
      this._broadcast();
      this._coachBroadcast();
    });
  }

  async rollbackStreet() {
    this._guardNotAwaiting();
    return this._enqueue(async () => {
      const p = this.engine.rollbackStreet(); // may re-enter awaiting_deal
      p.catch(() => {});
      await this._settle();
      if (!this.awaiting) await p;
      this._broadcast();
      this._coachBroadcast();
    });
  }

  async forceStreet() {
    this._guardNotAwaiting();
    return this._enqueue(async () => {
      const p = this.engine.forceStreet(); // next street may await the coach
      p.catch(() => {});
      await this._settle();
      if (!this.awaiting) await p;
      this._broadcast();
    });
  }

  async awardPot(playerId) {
    this._guardNotAwaiting();
    return this._enqueue(async () => {
      this.engine.awardPot(playerId);
      this._broadcast();
    });
  }

  async setStack(playerId, stack) {
    return this._enqueue(async () => {
      this.engine.setStack(playerId, stack);
      await this._persistSeats();
      this._broadcast();
    });
  }

  async setBlinds(smallBlind, bigBlind) {
    return this._enqueue(async () => {
      this.engine.setBlinds(smallBlind, bigBlind);
      this.config.smallBlind = smallBlind;
      this.config.bigBlind = bigBlind;
      await this.repos.tablesRepo.updateConfig(this.tableId, this.config);
      this._broadcast();
    });
  }

  /** Live tagging without stopping play (M4 §8). */
  async coachTag({ tag, playerId = null, actionSeq = null }) {
    const clean = String(tag ?? '').trim().slice(0, 120);
    if (!clean) throw new EngineError('invalid_tag');
    const row = { tag: clean, tag_type: 'coach', player_id: playerId, action_seq: actionSeq };
    if (this.engine.isHandRunning()) {
      this.pendingTags.push(row);
      return { buffered: true };
    }
    if (!this.lastHandId) throw new EngineError('no_hand');
    await this.repos.recordingRepo.addHandTags(this.lastHandId, [row]);
    return { handId: this.lastHandId };
  }

  // ── Scenarios & playlists (PRD §4, DEALING §4) ───────────────────────

  scenarioConfig(name = null) {
    return {
      name,
      panel: {
        slots: JSON.parse(JSON.stringify(this.panel.slots)),
        board: [...this.panel.board],
        streetPolicy: { ...this.panel.streetPolicy },
      },
      blinds: {
        smallBlind: this.engine.config.smallBlind,
        bigBlind: this.engine.config.bigBlind,
      },
      button: this.engine.button,
      stacks: this.engine.occupiedSeats().map((s) => ({
        seatIndex: s.seatIndex, stack: s.stack,
      })),
    };
  }

  async saveScenario({ name, description = null, createdBy }) {
    const config = this.scenarioConfig(name);
    return this.repos.scenariosRepo.create({ name, description, config, createdBy });
  }

  applyScenario(config) {
    if (this.engine.isHandRunning()) throw new EngineError('hand_in_progress');
    const panel = config?.panel ?? {};
    this.panel = {
      slots: JSON.parse(JSON.stringify(panel.slots ?? {})),
      board: [...(panel.board ?? [null, null, null, null, null])],
      streetPolicy: { flop: 'auto', turn: 'auto', river: 'auto', ...(panel.streetPolicy ?? {}) },
      fromScenario: true,
    };
    if (config?.blinds) {
      this.engine.setBlinds(config.blinds.smallBlind, config.blinds.bigBlind);
    }
    if (Number.isInteger(config?.button)) this.engine.button = config.button;
    for (const s of config?.stacks ?? []) {
      const seat = this.engine.seats[s.seatIndex];
      if (seat) seat.stack = s.stack;
    }
    this._coachBroadcast();
  }

  async loadPlaylist(playlistId) {
    const playlist = await this.repos.playlistsRepo.findById(playlistId);
    if (!playlist) throw new EngineError('playlist_not_found');
    const scenarios = await this.repos.playlistsRepo.listScenarios(playlistId);
    if (scenarios.length === 0) throw new EngineError('playlist_empty');
    this.drill = { playlistId, name: playlist.name, scenarios, index: 0 };
    this.applyScenario(scenarios[0].config);
    return this.drill;
  }

  nextDrill() {
    if (!this.drill) throw new EngineError('no_playlist');
    if (this.drill.index + 1 >= this.drill.scenarios.length) {
      throw new EngineError('playlist_finished');
    }
    this.drill.index += 1;
    this.applyScenario(this.drill.scenarios[this.drill.index].config);
    return this.drill;
  }

  // ── Branch-to-live (M6 §5) ───────────────────────────────────────────

  /**
   * Fork a replay point into live play: present participants keep their
   * reconstructed stacks-at-cursor and their recorded cards, the board is
   * pre-staged, and a fresh hand is dealt with origin='replay_branch'.
   * Bankroll is never involved (coached tables don't touch it). Chips are
   * conserved within the branch hand by the engine.
   */
  async branchFromHand(handDetail, cursor = 0) {
    // NOT wrapped in _enqueue: the setup is synchronous and this awaits
    // this.deal(), which enqueues itself — a double-enqueue would deadlock.
    if (this.closed) throw new EngineError('table_closed');
    if (this.engine.isHandRunning()) throw new EngineError('hand_in_progress');
    if (this._branch) throw new EngineError('already_branched');

    const replay = buildReplay(handDetail);
    const frame = replay.frameAt(cursor);
    const frameSeat = new Map(frame.seats.map((s) => [s.playerId, s]));

    // Snapshot present stacks so unbranch can restore the replay point.
    this._branch = {
      handId: handDetail.handId,
      cursor: frame.cursor,
      seatStacks: this.engine.occupiedSeats().map((s) => ({ playerId: s.playerId, stack: s.stack })),
    };

    const slots = {};
    for (const seat of this.engine.occupiedSeats()) {
      const fs = frameSeat.get(seat.playerId);
      if (!fs) continue;                       // seated player not in the recorded hand
      seat.stack = fs.stack;                   // reconstructed stack-at-cursor
      if (!fs.folded && fs.holeCards && fs.holeCards.length === 2) {
        slots[seat.playerId] = { mode: 'cards', cards: [...fs.holeCards] };
      }
    }
    this.panel = {
      slots,
      board: [0, 1, 2, 3, 4].map((i) => handDetail.board[i] ?? null),
      streetPolicy: { flop: 'manual', turn: 'manual', river: 'manual' },
      fromScenario: false,
      originOverride: 'replay_branch',
    };
    this.emit('branch', { tableId: this.tableId, handId: handDetail.handId, cursor: frame.cursor });
    await this.deal();
    return { branched: true, handId: handDetail.handId, cursor: frame.cursor };
  }

  /** Discard the branch and return to the replay point (restores stacks). */
  async unbranchFromHand() {
    return this._enqueue(async () => {
      if (!this._branch) throw new EngineError('not_branched');
      if (this.engine.isHandRunning()) throw new EngineError('hand_in_progress');
      for (const { playerId, stack } of this._branch.seatStacks) {
        const seat = this.engine.findSeat(playerId);
        if (seat) seat.stack = stack;
      }
      const at = { handId: this._branch.handId, cursor: this._branch.cursor };
      this._branch = null;
      this.panel = EMPTY_PANEL();
      this.emit('unbranch', { tableId: this.tableId, ...at });
      this._broadcast();
      this._coachBroadcast();
      return { unbranched: true, ...at };
    });
  }

  get branched() { return this._branch !== null; }

  // ── Group transition (M6 §6) ─────────────────────────────────────────

  /**
   * Move every connected player at this table into the same review session
   * (spectator technical state). Coach-driven navigation is synced to all;
   * independent per table because it lives on the runtime.
   */
  enterGroupReview(handDetail, cursor = 0) {
    this.groupReview = { hand: handDetail, cursor };
    this.emit('group_review', { tableId: this.tableId });
  }

  navGroupReview(cursor) {
    if (!this.groupReview) throw new EngineError('not_in_review');
    this.groupReview.cursor = cursor | 0;
    this.emit('group_review', { tableId: this.tableId });
  }

  exitGroupReview() {
    if (!this.groupReview) return;
    this.groupReview = null;
    this.emit('group_review', { tableId: this.tableId });
  }

  groupReviewState() {
    if (!this.groupReview) return null;
    return {
      tableId: this.tableId,
      handId: this.groupReview.hand.handId,
      cursor: this.groupReview.cursor,
      hand: this.groupReview.hand, // open-kimono review payload (all hole cards)
    };
  }

  // ── Lifecycle & recording ────────────────────────────────────────────

  async _activateIfNeeded() {
    if (this.status === 'open') {
      this.status = 'active';
      await this.repos.tablesRepo.setStatus(this.tableId, 'active');
      const session = await this.repos.recordingRepo.openSession({
        tableId: this.tableId, tableMode: 'coached_cash',
        crmEntryId: this.crmEntryId, coachPlayerId: this.coachPlayerId,
      });
      this.sessionId = session.id;
      // A lesson's playlist preloads at activation (M4 §9).
      if (this.config.playlistId && !this.drill) {
        try { await this.loadPlaylist(this.config.playlistId); } catch { /* dangling ref — surfaced in coach state */ }
      }
    }
  }

  _onEngineEvent(event) {
    if (event.type === 'hand_started') {
      // Hole cards exist now — capture what the coach may see (§5).
      this._captureAssignedVisibility();
      this._coachBroadcast();
    }
    if (event.type === 'hand_complete') {
      this._enqueue(() => this._afterHand(event.record)).catch(() => {});
    }
    if (['street', 'hand_started', 'action', 'awaiting_action', 'undo', 'street_rollback'].includes(event.type)) {
      this.emit(event.type, { tableId: this.tableId, ...event });
    }
  }

  async _afterHand(record) {
    await this._persistSeats();
    // M5 analyzer pipeline — isolated per analyzer, never blocks recording.
    // Settings were snapshotted at deal time (§6 non-retroactive).
    const autoTags = analyzeHand(record, { settings: this._handSettings });
    const handId = await this.repos.recordingRepo.recordHand(
      this.sessionId, record, [...autoTags, ...this.pendingTags]
    );
    this.lastHandId = handId;
    this.pendingTags = [];
    this.awaiting = null;
    this._broadcast();
    this._coachBroadcast();
  }

  async _persistSeats() {
    await this.repos.tablesRepo.saveSeats(this.tableId, this.engine.snapshotSeats());
  }

  playerConnected(playerId) {
    this.connected.add(playerId);
    this._armEmptyClose();
    this._broadcast();
  }

  playerDisconnected(playerId) {
    this.connected.delete(playerId);
    // Nothing automatic — the coach owns the room (RUNTIME §2).
    this._armEmptyClose();
  }

  /** RUNTIME §3: auto-close 60 min after scheduled_end if empty. */
  _armEmptyClose() {
    clearTimeout(this._emptyTimer);
    if (this.closed || !this.scheduledEnd) return;
    const graceMs = this.timers.emptyCloseMs ?? 60 * 60 * 1000;
    const fireAt = new Date(this.scheduledEnd).getTime() + graceMs;
    const delay = Math.max(0, fireAt - Date.now());
    this._emptyTimer = setTimeout(() => {
      if (this.connected.size === 0) this.close('empty_after_lesson').catch(() => {});
      else this._armEmptyClose(); // someone still here — re-check later
    }, delay);
    if (this._emptyTimer.unref) this._emptyTimer.unref();
  }

  stop() {
    clearTimeout(this._emptyTimer);
  }

  async close(reason = 'ended_by_coach') {
    return this._enqueue(async () => {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this._emptyTimer);
      await this.repos.tablesRepo.saveSeats(this.tableId, []);
      await this.repos.tablesRepo.setStatus(this.tableId, 'completed');
      if (this.sessionId) await this.repos.recordingRepo.finalizeSession(this.sessionId);
      this.emit('table_closed', { tableId: this.tableId, reason });
    });
  }

  // ── Views (visibility enforced here, server-side) ───────────────────

  publicState(viewerId) {
    const state = this.engine.getPublicState(viewerId);
    return {
      tableId: this.tableId,
      mode: 'coached_cash',
      name: this.config.name || null,
      status: this.closed ? 'completed' : this.status,
      paused: this.paused,
      // Neutral: players learn only that the dealer is acting (§3).
      awaitingDeal: Boolean(this.awaiting),
      connected: [...this.connected],
      actionDeadline: null,
      branched: this.branched,
      drill: this.drill
        ? { name: this.drill.name, index: this.drill.index, count: this.drill.scenarios.length }
        : null,
      ...state,
    };
  }

  /**
   * Coach sidebar payload. Contains the panel and ONLY coach-assigned
   * cards / range draws for the live hand — never pure-RNG holes.
   */
  coachState() {
    return {
      tableId: this.tableId,
      panel: {
        slots: this.panel.slots,
        board: [...this.panel.board],
        streetPolicy: { ...this.panel.streetPolicy },
        fromScenario: this.panel.fromScenario,
      },
      awaiting: this.awaiting,
      assigned: this.engine.isHandRunning() ? this.assignedVisible : {},
      drill: this.drill
        ? { name: this.drill.name, index: this.drill.index, count: this.drill.scenarios.length }
        : null,
      openSeating: this.openSeating,
      seatList: this.seatList(),
      paused: this.paused,
      branched: this.branched,
      inGroupReview: this.groupReview !== null,
      lastHandId: this.lastHandId,
    };
  }

  _broadcast() {
    this.emit('state', { tableId: this.tableId });
  }

  _coachBroadcast() {
    this.emit('coach_state', { tableId: this.tableId });
  }
}
