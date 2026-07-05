import { TableEngine, EngineError } from '../game/TableEngine.js';
import { rngCardSourceFactory } from '../game/cardSource.js';

/**
 * TableRuntime — everything around the pure engine for one uncoached cash
 * table: timers, bankroll flows, recording, snapshots, connections.
 * (RUNTIME §2–4.)
 *
 * All durations are injectable so tests can run them in milliseconds.
 */
export const DEFAULT_TIMERS = {
  actionMs: 30_000,        // action timer, auto check/fold (RUNTIME §4)
  interHandMs: 2_000,      // pause between hands (M2 §3)
  disconnectGraceMs: 60_000,   // disconnect → auto sit-out (RUNTIME §2)
  retentionMs: 300_000,    // sat-out disconnected → auto cash-out (RUNTIME §2)
  idleCloseMs: 600_000,    // zero connected players → close table (RUNTIME §3)
};

export class TableRuntime {
  constructor({
    tableRow, repos, emit = () => {}, timers = {},
    cardSourceFactory = rngCardSourceFactory(),
  }) {
    this.tableId = tableRow.id;
    this.config = tableRow.config; // { smallBlind, bigBlind, tableSize, name }
    this.status = tableRow.status;
    this.repos = repos; // { tablesRepo, bankrollRepo, recordingRepo, playersRepo }
    this.emit = emit;   // (event, payload) → socket layer
    this.timers = { ...DEFAULT_TIMERS, ...timers };
    this.sessionId = null;
    this.closed = false;

    this.engine = new TableEngine({
      config: {
        smallBlind: this.config.smallBlind,
        bigBlind: this.config.bigBlind,
        tableSize: this.config.tableSize,
      },
      cardSourceFactory,
      listener: (event) => this._onEngineEvent(event),
    });

    this.connected = new Set();       // playerIds with ≥1 live socket
    this._timers = {};                // named timer handles
    this._playerTimers = new Map();   // playerId → { grace, retention }
    this._chain = Promise.resolve();  // serializes engine mutations
    this._idleTimer = null;
    this._armIdleClose();
  }

  // ── Serialization helper ─────────────────────────────────────────────

  _enqueue(fn) {
    const next = this._chain.then(fn, fn);
    // Keep the chain alive after failures; callers get the real promise.
    this._chain = next.catch(() => {});
    return next;
  }

  // ── Seating & money ──────────────────────────────────────────────────

  buyInBounds() {
    const bb = this.config.bigBlind;
    return { min: 50 * bb, max: 250 * bb, defaultAmount: 100 * bb };
  }

  async join({ player, buyIn, seatIndex = null }) {
    return this._enqueue(async () => {
      if (this.closed) throw new EngineError('table_closed');
      const { min, max } = this.buyInBounds();
      if (!Number.isInteger(buyIn) || buyIn < min || buyIn > max) {
        throw new EngineError('invalid_buy_in');
      }
      // Debit first (atomic, CHECK balance >= 0 blocks insufficient funds),
      // then seat; unseat failure refunds.
      await this.repos.bankrollRepo.applyTransaction({
        playerId: player.id, type: 'buy_in', amount: -buyIn, refId: this.tableId,
      });
      try {
        this.engine.seatPlayer({
          playerId: player.id, name: player.display_name, stack: buyIn, seatIndex,
        });
      } catch (err) {
        await this.repos.bankrollRepo.applyTransaction({
          playerId: player.id, type: 'cash_out', amount: buyIn, refId: this.tableId,
        });
        throw err;
      }
      await this._persistSeats();
      await this._activateIfNeeded();
      this._broadcast();
      this._maybeScheduleNextHand();
      return this.engine.findSeat(player.id);
    });
  }

  /** Re-entry after bust (M2 §3): same seat, fresh buy-in. */
  async rebuy({ player, buyIn }) {
    return this._enqueue(async () => {
      if (this.closed) throw new EngineError('table_closed');
      const seat = this.engine.findSeat(player.id);
      if (!seat) throw new EngineError('not_seated');
      if (seat.stack > 0) throw new EngineError('not_busted');
      const { min, max } = this.buyInBounds();
      if (!Number.isInteger(buyIn) || buyIn < min || buyIn > max) {
        throw new EngineError('invalid_buy_in');
      }
      await this.repos.bankrollRepo.applyTransaction({
        playerId: player.id, type: 'buy_in', amount: -buyIn, refId: this.tableId,
      });
      this.engine.addChips(player.id, buyIn);
      this.engine.setSitOut(player.id, false);
      await this._persistSeats();
      this._broadcast();
      this._maybeScheduleNextHand();
      return this.engine.findSeat(player.id);
    });
  }

  async leave(playerId) {
    return this._enqueue(() => this._cashOutAndUnseat(playerId));
  }

  async _cashOutAndUnseat(playerId) {
    const seat = this.engine.findSeat(playerId);
    if (!seat) throw new EngineError('not_seated');
    this._clearPlayerTimers(playerId);
    await this.engine.unseat(playerId); // mid-hand: folds, seat frees at hand end
    // A mid-hand leaver abandons chips already committed to the pot; the
    // remaining stack banks now (RUNTIME §2).
    const stack = seat.stack;
    seat.stack = 0;
    if (stack > 0) {
      await this.repos.bankrollRepo.applyTransaction({
        playerId, type: 'cash_out', amount: stack, refId: this.tableId,
      });
    }
    if (!this.engine.isHandRunning()) await this._persistSeats();
    this._broadcast();
    this._maybeScheduleNextHand();
    return stack;
  }

  async sitOut(playerId, sitOut) {
    return this._enqueue(async () => {
      this.engine.setSitOut(playerId, sitOut);
      await this._persistSeats();
      this._broadcast();
      if (!sitOut) this._maybeScheduleNextHand();
    });
  }

  async act(playerId, action) {
    return this._enqueue(async () => {
      await this.engine.act(playerId, action);
      this._broadcast();
    });
  }

  // ── Connections (RUNTIME §2) ─────────────────────────────────────────

  playerConnected(playerId) {
    this.connected.add(playerId);
    this._clearPlayerTimers(playerId);
    this._armIdleClose();
    this._broadcast();
  }

  playerDisconnected(playerId) {
    this.connected.delete(playerId);
    const seat = this.engine.findSeat(playerId);
    if (seat) {
      const grace = setTimeout(() => {
        this._enqueue(async () => {
          if (this.closed || !this.engine.findSeat(playerId)) return;
          this.engine.setSitOut(playerId, true);
          await this._persistSeats();
          this._broadcast();
        });
      }, this.timers.disconnectGraceMs);
      const retention = setTimeout(() => {
        this._enqueue(async () => {
          if (this.closed || !this.engine.findSeat(playerId)) return;
          await this._cashOutAndUnseat(playerId);
        }).catch(() => {});
      }, this.timers.retentionMs);
      this._playerTimers.set(playerId, { grace, retention });
    }
    this._armIdleClose();
  }

  _clearPlayerTimers(playerId) {
    const t = this._playerTimers.get(playerId);
    if (t) {
      clearTimeout(t.grace);
      clearTimeout(t.retention);
      this._playerTimers.delete(playerId);
    }
  }

  _armIdleClose() {
    clearTimeout(this._idleTimer);
    if (this.closed) return;
    if (this.connected.size === 0) {
      this._idleTimer = setTimeout(() => {
        this.close('idle').catch(() => {});
      }, this.timers.idleCloseMs);
    }
  }

  // ── Hand loop ────────────────────────────────────────────────────────

  async _activateIfNeeded() {
    if (this.status === 'open' && this.engine.eligibleSeats().length >= 2) {
      this.status = 'active';
      await this.repos.tablesRepo.setStatus(this.tableId, 'active');
      const session = await this.repos.recordingRepo.openSession({
        tableId: this.tableId, tableMode: 'uncoached_cash',
      });
      this.sessionId = session.id;
    }
  }

  _maybeScheduleNextHand() {
    if (this.closed || this.engine.isHandRunning()) return;
    if (!this.engine.canStartHand()) return;
    if (this._timers.nextHand) return;
    this._timers.nextHand = setTimeout(() => {
      delete this._timers.nextHand;
      this._enqueue(async () => {
        if (this.closed || !this.engine.canStartHand()) return;
        await this._activateIfNeeded();
        await this.engine.startHand();
        this._broadcast();
      }).catch(() => {});
    }, this.timers.interHandMs);
  }

  _onEngineEvent(event) {
    if (event.type === 'awaiting_action') {
      this._armActionTimer(event.playerId);
      this.emit('awaiting_action', { tableId: this.tableId, ...event });
    }
    if (event.type === 'hand_complete') {
      clearTimeout(this._timers.action);
      // Recording + snapshot are async; queue them behind the current op.
      this._enqueue(() => this._afterHand(event.record)).catch(() => {});
    }
    if (event.type === 'street' || event.type === 'hand_started' || event.type === 'action') {
      this.emit(event.type, { tableId: this.tableId, ...event });
    }
  }

  _armActionTimer(playerId) {
    clearTimeout(this._timers.action);
    this._timers.action = setTimeout(() => {
      this._enqueue(async () => {
        if (this.closed) return;
        await this.engine.autoAct(playerId); // check when legal, else fold
        this._broadcast();
      }).catch(() => {});
    }, this.timers.actionMs);
  }

  async _afterHand(record) {
    // RUNTIME §1: stacks persist after every completed hand; then record.
    await this._persistSeats();
    await this.repos.recordingRepo.recordHand(this.sessionId, record);

    // Busted players sit out until they re-buy or leave (M2 §3).
    for (const seat of this.engine.occupiedSeats()) {
      if (seat.stack === 0 && !seat.sittingOut) {
        this.engine.setSitOut(seat.playerId, true);
        this.emit('busted', { tableId: this.tableId, playerId: seat.playerId });
      }
    }
    await this._persistSeats();
    this._broadcast();
    this._maybeScheduleNextHand();
  }

  async _persistSeats() {
    await this.repos.tablesRepo.saveSeats(this.tableId, this.engine.snapshotSeats());
  }

  /** Stop all timers WITHOUT closing — process shutdown / crash simulation. */
  stop() {
    clearTimeout(this._idleTimer);
    for (const key of Object.keys(this._timers)) clearTimeout(this._timers[key]);
    for (const playerId of [...this._playerTimers.keys()]) {
      this._clearPlayerTimers(playerId);
    }
  }

  // ── Close (RUNTIME §3) ───────────────────────────────────────────────

  async close(reason = 'closed') {
    return this._enqueue(async () => {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this._idleTimer);
      for (const key of Object.keys(this._timers)) clearTimeout(this._timers[key]);
      for (const playerId of [...this._playerTimers.keys()]) {
        this._clearPlayerTimers(playerId);
      }
      // Cash out every remaining stack to its bankroll.
      for (const seat of this.engine.occupiedSeats()) {
        if (seat.stack > 0) {
          await this.repos.bankrollRepo.applyTransaction({
            playerId: seat.playerId, type: 'cash_out',
            amount: seat.stack, refId: this.tableId,
          });
        }
      }
      await this.repos.tablesRepo.saveSeats(this.tableId, []);
      await this.repos.tablesRepo.setStatus(this.tableId, 'completed');
      if (this.sessionId) {
        await this.repos.recordingRepo.finalizeSession(this.sessionId);
      }
      this.emit('table_closed', { tableId: this.tableId, reason });
    });
  }

  // ── Views ────────────────────────────────────────────────────────────

  publicState(viewerId) {
    const state = this.engine.getPublicState(viewerId);
    return {
      tableId: this.tableId,
      name: this.config.name || null,
      status: this.closed ? 'completed' : this.status,
      connected: [...this.connected],
      ...state,
    };
  }

  _broadcast() {
    this.emit('state', { tableId: this.tableId });
  }
}
