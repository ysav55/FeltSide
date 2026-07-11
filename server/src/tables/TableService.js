import { TableRuntime } from './TableRuntime.js';
import { CoachedTableRuntime } from './CoachedTableRuntime.js';
import { TournamentRuntime } from './TournamentRuntime.js';
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
      if (row.mode === 'tournament') {
        await this._recoverTournament(row);
        continue;
      }
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

  /** RUNTIME §1 tournament recovery: clock + tables layout from the state jsonb. */
  async _recoverTournament(tableRow) {
    const tournamentRow = await this.repos.tournamentsRepo.findByTableId(tableRow.id);
    if (!tournamentRow || tournamentRow.status === 'completed') return;
    const runtime = this._buildTournamentRuntime(tableRow, tournamentRow);
    runtime.sessionId = (await this.repos.recordingRepo.findOpenSession(tableRow.id))?.id ?? null;
    const entries = await this.repos.tournamentsRepo.listEntries(tournamentRow.id);
    runtime.restore(tournamentRow.state, entries);
    this.runtimes.set(tableRow.id, runtime);
    runtime.resumeAfterRestore();
    return runtime;
  }

  _buildTournamentRuntime(tableRow, tournamentRow) {
    return new TournamentRuntime({
      tableRow,
      tournamentRow,
      repos: this.repos,
      emit: this.emit,
      timers: this.timers,
      settingsProvider: this.settingsProvider,
      ...(this.cardSourceFactory ? { cardSourceFactory: this.cardSourceFactory } : {}),
    });
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
  async openScheduled(tableId, coach, { presetId = null } = {}) {
    if (this.runtimes.has(tableId)) return this.runtimes.get(tableId);
    const row = await this.repos.tablesRepo.findById(tableId);
    if (!row || row.status !== 'scheduled') throw new EngineError('not_scheduled');
    if (row.mode === 'tournament') {
      return this._activateTournament({ ...row, status: 'open' }, { presetId });
    }
    await this.repos.tablesRepo.setStatus(tableId, 'open');
    const runtime = this._buildCoachedRuntime({ ...row, status: 'open' }, coach.id);
    this.runtimes.set(tableId, runtime);
    return runtime;
  }

  /**
   * TOURNAMENTS §3: scheduled → registering. The tournament row snapshots
   * the preset config so later preset edits never shift a live tournament.
   * A CRM-pushed table carries its preset by reference (CONTRACT §8);
   * the coach may override with an explicit presetId.
   */
  async _activateTournament(tableRow, { presetId = null } = {}) {
    const chosen = presetId ?? tableRow.config?.tournamentPresetId ?? null;
    if (!chosen) throw new EngineError('preset_required');
    const preset = await this.repos.tournamentPresetsRepo.findById(chosen);
    if (!preset) throw new EngineError('preset_not_found');
    await this.repos.tablesRepo.setStatus(tableRow.id, 'open');
    const tournamentRow = await this.repos.tournamentsRepo.create({
      tableId: tableRow.id,
      presetId: preset.id,
      config: { ...preset.config, name: tableRow.config?.name ?? preset.config.name },
    });
    const runtime = this._buildTournamentRuntime(tableRow, tournamentRow);
    this.runtimes.set(tableRow.id, runtime);
    runtime.armAutoStart();
    return runtime;
  }

  /** Ad-hoc tournament from the lobby (coach-only, route-enforced). */
  async createTournament({ coach, presetId, name = null, scheduledStart = null }) {
    const preset = await this.repos.tournamentPresetsRepo.findById(presetId);
    if (!preset) throw new EngineError('preset_not_found');
    const config = { name: name ?? preset.name };
    const row = scheduledStart
      ? await this.repos.tablesRepo.createScheduled({
          mode: 'tournament', config, crmEntryId: null,
          scheduledStart, scheduledEnd: null,
        })
      : await this.repos.tablesRepo.create({
          mode: 'tournament', createdBy: coach.id, config,
        });
    return this._activateTournament({ ...row, status: 'open' }, { presetId });
  }

  /**
   * Lobby backstop: CRM-pushed tournaments open for registration on their
   * own once inside the registration window (1h before scheduled start) —
   * autonomous by default (TOURNAMENTS §3); the coach may still open early.
   */
  async autoOpenTournaments(now = Date.now(), aheadMs = 60 * 60_000) {
    const rows = await this.repos.tablesRepo.listNonCompleted();
    let opened = 0;
    for (const row of rows) {
      if (row.mode !== 'tournament' || row.status !== 'scheduled') continue;
      if (!row.scheduled_start || !row.config?.tournamentPresetId) continue;
      if (new Date(row.scheduled_start).getTime() - now > aheadMs) continue;
      try {
        await this._activateTournament({ ...row, status: 'open' });
        opened += 1;
      } catch { /* preset gone or race — the coach can still open manually */ }
    }
    return opened;
  }

  get(tableId) {
    return this.runtimes.get(tableId) || null;
  }

  /** The table a player is currently seated at (reconnect support). */
  findSeatedTable(playerId) {
    for (const runtime of this.runtimes.values()) {
      if (runtime.closed) continue;
      const present = runtime.hasPlayer
        ? runtime.hasPlayer(playerId)          // tournament: registered = present
        : runtime.engine.findSeat(playerId);
      if (present) return runtime;
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
