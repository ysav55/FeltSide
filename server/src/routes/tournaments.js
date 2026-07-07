import { Router } from 'express';
import { EngineError } from '../game/TableEngine.js';

function engineErrorToHttp(err, res) {
  if (err instanceof EngineError) {
    const notFound = ['table_closed', 'not_seated', 'preset_not_found', 'table_not_found'];
    return res.status(notFound.includes(err.code) ? 404 : 400).json({ error: err.code });
  }
  if (err?.name === 'InsufficientBalanceError') {
    return res.status(400).json({ error: 'insufficient_balance' });
  }
  return null;
}

/** Shallow §1 shape check — the coach edits freely; we stop only nonsense. */
function validatePresetConfig(config) {
  if (!config || typeof config !== 'object') return 'invalid_config';
  if (!Number.isInteger(config.buy_in) || config.buy_in < 1) return 'invalid_buy_in';
  if (![6, 9].includes(config.table_size)) return 'invalid_table_size';
  if (!Number.isInteger(config.starting_stack_bb) || config.starting_stack_bb < 1) return 'invalid_stack';
  if (!Array.isArray(config.blind_ladder) || config.blind_ladder.length === 0) return 'invalid_ladder';
  for (const row of config.blind_ladder) {
    if (!Number.isInteger(row?.bb) || row.bb < 1) return 'invalid_ladder';
    if (!Number.isInteger(row.sb) || row.sb < 1) return 'invalid_ladder'; // chips are whole
  }
  return null;
}

/** Preset CRUD (TOURNAMENTS §1; coach-editable, exported via §4.7). */
export function buildTournamentPresetsRoutes({ tournamentPresetsRepo, requireAuth, requireCoach }) {
  const router = Router();

  router.get('/', requireAuth(), async (req, res, next) => {
    try {
      res.json({ data: await tournamentPresetsRepo.list() });
    } catch (err) { next(err); }
  });

  router.post('/', requireAuth(), requireCoach, async (req, res, next) => {
    try {
      const { name, description = null, config } = req.body || {};
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name_required' });
      }
      const invalid = validatePresetConfig(config);
      if (invalid) return res.status(400).json({ error: invalid });
      const row = await tournamentPresetsRepo.create({
        name: name.trim().slice(0, 120),
        description,
        config: { ...config, name: name.trim().slice(0, 120) },
        createdBy: req.player.id,
      });
      res.status(201).json({ preset: row });
    } catch (err) { next(err); }
  });

  router.put('/:id', requireAuth(), requireCoach, async (req, res, next) => {
    try {
      const { name = null, description = null, config = null } = req.body || {};
      if (config !== null) {
        const invalid = validatePresetConfig(config);
        if (invalid) return res.status(400).json({ error: invalid });
      }
      const row = await tournamentPresetsRepo.update(req.params.id, { name, description, config });
      if (!row) return res.status(404).json({ error: 'not_found' });
      res.json({ preset: row });
    } catch (err) { next(err); }
  });

  router.delete('/:id', requireAuth(), requireCoach, async (req, res, next) => {
    try {
      const gone = await tournamentPresetsRepo.remove(req.params.id);
      if (!gone) return res.status(404).json({ error: 'not_found' });
      res.json({ deleted: true });
    } catch (err) { next(err); }
  });

  return router;
}

/**
 * Tournament actions (TOURNAMENTS §§3, 6, 7), keyed by the anchor table id.
 * Registration overrides (§6): the coach may register/re-enter ANY player
 * past the window — soft limits guide, never block him.
 */
export function buildTournamentsRoutes({ tableService, playersRepo, requireAuth, requireCoach }) {
  const router = Router();

  const tournament = (req, res) => {
    const runtime = tableService.get(req.params.tableId);
    if (!runtime || runtime.closed || runtime.mode !== 'tournament') {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    return runtime;
  };

  /** Self by default; a coach may act for another player (override). */
  const subject = async (req, res) => {
    const targetId = req.body?.player_id;
    if (!targetId || targetId === req.player.id) return { player: req.player, override: false };
    if (req.player.role !== 'coach') {
      res.status(403).json({ error: 'coach_only' });
      return null;
    }
    const player = await playersRepo.findById(targetId);
    if (!player) {
      res.status(404).json({ error: 'player_not_found' });
      return null;
    }
    return { player, override: true };
  };

  router.post('/', requireAuth(), requireCoach, async (req, res, next) => {
    try {
      const { preset_id: presetId, name = null, scheduled_start: scheduledStart = null } = req.body || {};
      if (!presetId) return res.status(400).json({ error: 'preset_required' });
      const runtime = await tableService.createTournament({
        coach: req.player, presetId, name, scheduledStart,
      });
      res.status(201).json({ table: runtime.publicState(req.player.id) });
    } catch (err) {
      if (engineErrorToHttp(err, res)) return;
      next(err);
    }
  });

  router.post('/:tableId/register', requireAuth(), async (req, res, next) => {
    try {
      const runtime = tournament(req, res);
      if (!runtime) return;
      const s = await subject(req, res);
      if (!s) return;
      await runtime.register(s.player, { override: s.override });
      res.status(201).json({ table: runtime.publicState(req.player.id) });
    } catch (err) {
      if (engineErrorToHttp(err, res)) return;
      next(err);
    }
  });

  router.post('/:tableId/reenter', requireAuth(), async (req, res, next) => {
    try {
      const runtime = tournament(req, res);
      if (!runtime) return;
      const s = await subject(req, res);
      if (!s) return;
      await runtime.reenter(s.player, { override: s.override });
      res.json({ table: runtime.publicState(req.player.id) });
    } catch (err) {
      if (engineErrorToHttp(err, res)) return;
      next(err);
    }
  });

  router.post('/:tableId/addon', requireAuth(), async (req, res, next) => {
    try {
      const runtime = tournament(req, res);
      if (!runtime) return;
      const s = await subject(req, res);
      if (!s) return;
      await runtime.addon(s.player);
      res.json({ table: runtime.publicState(req.player.id) });
    } catch (err) {
      if (engineErrorToHttp(err, res)) return;
      next(err);
    }
  });

  router.post('/:tableId/start', requireAuth(), requireCoach, async (req, res, next) => {
    try {
      const runtime = tournament(req, res);
      if (!runtime) return;
      await runtime.start();
      res.json({ table: runtime.publicState(req.player.id) });
    } catch (err) {
      if (engineErrorToHttp(err, res)) return;
      next(err);
    }
  });

  // §7 deal flow: coach proposes/cancels; every live player must accept.
  router.post('/:tableId/deal/propose', requireAuth(), requireCoach, async (req, res, next) => {
    try {
      const runtime = tournament(req, res);
      if (!runtime) return;
      res.json({ deal: runtime.proposeDeal() });
    } catch (err) {
      if (engineErrorToHttp(err, res)) return;
      next(err);
    }
  });

  router.post('/:tableId/deal/accept', requireAuth(), async (req, res, next) => {
    try {
      const runtime = tournament(req, res);
      if (!runtime) return;
      const result = await runtime.acceptDeal(req.player.id);
      res.json(result);
    } catch (err) {
      if (engineErrorToHttp(err, res)) return;
      next(err);
    }
  });

  router.delete('/:tableId/deal', requireAuth(), requireCoach, async (req, res, next) => {
    try {
      const runtime = tournament(req, res);
      if (!runtime) return;
      runtime.cancelDeal();
      res.json({ cancelled: true });
    } catch (err) {
      if (engineErrorToHttp(err, res)) return;
      next(err);
    }
  });

  // §6 end-early: the lesson-overrun escape hatch.
  router.post('/:tableId/end-early', requireAuth(), requireCoach, async (req, res, next) => {
    try {
      const runtime = tournament(req, res);
      if (!runtime) return;
      await runtime.endEarly();
      res.json({ table: runtime.publicState(req.player.id) });
    } catch (err) {
      if (engineErrorToHttp(err, res)) return;
      next(err);
    }
  });

  return router;
}
