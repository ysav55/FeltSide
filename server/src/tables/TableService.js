import { TableRuntime } from './TableRuntime.js';
import { CoachedTableRuntime } from './CoachedTableRuntime.js';
import { EngineError } from '../game/TableEngine.js';

/**
 * TableService — registry of live table runtimes + boot recovery
 * (RUNTIME §1: rebuild from snapshots, void any in-flight hand).
 */
export class TableService {
  constructor({ repos, emit = () => {}, timers = {}, cardSourceFactory, settingsProvider = null }) {
    this.repos = repos;
    this.emit = emit;
    this.timers = timers;
    this.cardSourceFactory = cardSourceFactory;
    this.settingsProvider = settingsProvider; // () => analyzer settings overrides
    this.runtimes = new Map(); // tableId → runtime (uncoached or coached)
  }

  /** Boot recovery: every non-completed table is rebuilt from its snapshot. */
  async recover() {
    const rows = await this.repos.tablesRepo.listNonCompleted();
    for (const row of rows) {
      if (row.status === 'scheduled') continue; // inert until opened (M4 §1)
      if (row.mode === 'tournament') continue;  // M7
      const runtime = row.mode === 'coached_cash'
        ? this._buildCoachedRuntime(row)
        : this._buildRuntime(row);
      if (row.mode === 'coached_cash') runtime.status = row.status;
      runtime.sessionId = (await this.repos.recordingRepo.findOpenSession(row.id))?.id ?? null;
      // Restore seats from the last completed-hand snapshot. Any hand that
      // was in flight at crash time existed only in memory — it is voided
      // by construction (stacks are hand-start values; nothing recorded).
      runtime.engine.restoreSeats(row.seats || []);
      this.runtimes.set(row.id, runtime);
      if (row.mode === 'uncoached_cash') runtime._maybeScheduleNextHand();
    }
    return this.runtimes.size;
  }

  _buildCoachedRuntime(tableRow, coachPlayerId = null) {
    return new CoachedTableRuntime({
      tableRow,
      repos: this.repos,
      emit: this.emit,
      timers: this.timers,
      coachPlayerId,
      settingsProvider: this.settingsProvider,
    });
  }

  _buildRuntime(tableRow) {
    return new TableRuntime({
      tableRow,
      repos: this.repos,
      emit: this.emit,
      timers: this.timers,
      settingsProvider: this.settingsProvider,
      ...(this.cardSourceFactory ? { cardSourceFactory: this.cardSourceFactory } : {}),
    });
  }

  async createTable({ creator, smallBlind, bigBlind, tableSize, name = null }) {
    if (!Number.isInteger(smallBlind) || smallBlind < 1) throw new EngineError('invalid_blinds');
    if (!Number.isInteger(bigBlind) || bigBlind < smallBlind) throw new EngineError('invalid_blinds');
    if (![6, 9].includes(tableSize)) throw new EngineError('invalid_table_size');

    const config = { smallBlind, bigBlind, tableSize, name };
    const row = await this.repos.tablesRepo.create({
      mode: 'uncoached_cash', createdBy: creator.id, config,
    });
    const runtime = this._buildRuntime(row);
    this.runtimes.set(row.id, runtime);
    return runtime;
  }

  /** Ad-hoc coached table from the lobby (M4 §1; coach-only, route-enforced). */
  async createCoachedTable({ coach, smallBlind, bigBlind, tableSize, name = null, defaultStack = null }) {
    if (!Number.isInteger(smallBlind) || smallBlind < 1) throw new EngineError('invalid_blinds');
    if (!Number.isInteger(bigBlind) || bigBlind < smallBlind) throw new EngineError('invalid_blinds');
    if (![6, 9].includes(tableSize)) throw new EngineError('invalid_table_size');

    const config = {
      smallBlind, bigBlind, tableSize, name,
      ...(defaultStack ? { defaultStack } : {}),
    };
    const row = await this.repos.tablesRepo.create({
      mode: 'coached_cash', createdBy: coach.id, config,
    });
    const runtime = this._buildCoachedRuntime(row, coach.id);
    this.runtimes.set(row.id, runtime);
    return runtime;
  }

  /**
   * A lesson-synced SCHEDULED table becomes joinable (M4 §1). Soft limits:
   * the coach may open early — restrictions guide, never block him.
   */
  async openScheduled(tableId, coach) {
    if (this.runtimes.has(tableId)) return this.runtimes.get(tableId);
    const row = await this.repos.tablesRepo.findById(tableId);
    if (!row || row.status !== 'scheduled') throw new EngineError('not_scheduled');
    if (row.mode === 'tournament') throw new EngineError('tournaments_m7');
    await this.repos.tablesRepo.setStatus(tableId, 'open');
    const runtime = this._buildCoachedRuntime({ ...row, status: 'open' }, coach.id);
    this.runtimes.set(tableId, runtime);
    return runtime;
  }

  get(tableId) {
    return this.runtimes.get(tableId) || null;
  }

  /** The table a player is currently seated at (reconnect support). */
  findSeatedTable(playerId) {
    for (const runtime of this.runtimes.values()) {
      if (!runtime.closed && runtime.engine.findSeat(playerId)) return runtime;
    }
    return null;
  }

  async closeTable(tableId, reason) {
    const runtime = this.get(tableId);
    if (runtime) {
      await runtime.close(reason);
      this.runtimes.delete(tableId);
    }
  }
}
