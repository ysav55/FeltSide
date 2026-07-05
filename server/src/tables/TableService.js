import { TableRuntime } from './TableRuntime.js';
import { EngineError } from '../game/TableEngine.js';

/**
 * TableService — registry of live table runtimes + boot recovery
 * (RUNTIME §1: rebuild from snapshots, void any in-flight hand).
 */
export class TableService {
  constructor({ repos, emit = () => {}, timers = {}, cardSourceFactory }) {
    this.repos = repos;
    this.emit = emit;
    this.timers = timers;
    this.cardSourceFactory = cardSourceFactory;
    this.runtimes = new Map(); // tableId → TableRuntime
  }

  /** Boot recovery: every non-completed table is rebuilt from its snapshot. */
  async recover() {
    const rows = await this.repos.tablesRepo.listNonCompleted();
    for (const row of rows) {
      if (row.mode !== 'uncoached_cash') continue; // other modes are M4+
      const runtime = this._buildRuntime(row);
      runtime.sessionId = (await this.repos.recordingRepo.findOpenSession(row.id))?.id ?? null;
      // Restore seats from the last completed-hand snapshot. Any hand that
      // was in flight at crash time existed only in memory — it is voided
      // by construction (stacks are hand-start values; nothing recorded).
      runtime.engine.restoreSeats(row.seats || []);
      this.runtimes.set(row.id, runtime);
      runtime._maybeScheduleNextHand();
    }
    return this.runtimes.size;
  }

  _buildRuntime(tableRow) {
    return new TableRuntime({
      tableRow,
      repos: this.repos,
      emit: this.emit,
      timers: this.timers,
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
