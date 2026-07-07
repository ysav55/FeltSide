import { Router } from 'express';
import { EngineError } from '../game/TableEngine.js';

function engineErrorToHttp(err, res) {
  if (err instanceof EngineError) {
    const status = err.code === 'table_closed' || err.code === 'not_seated' ? 404 : 400;
    return res.status(status).json({ error: err.code });
  }
  if (err?.name === 'InsufficientBalanceError') {
    return res.status(400).json({ error: 'insufficient_balance' });
  }
  return null;
}

export function buildTablesRoutes({ tablesRepo, tableService, requireAuth }) {
  const router = Router();

  router.get('/', requireAuth(), async (req, res, next) => {
    try {
      const rows = await tablesRepo.list();
      res.json({
        data: rows.map((t) => ({
          ...t,
          seated: Array.isArray(t.seats) ? t.seats.length : 0,
          seats: undefined,
        })),
      });
    } catch (err) { next(err); }
  });

  // The table this player is seated at, if any (reconnect flow).
  router.get('/me', requireAuth(), (req, res) => {
    const runtime = tableService.findSeatedTable(req.player.id);
    if (!runtime) return res.json({ table: null });
    res.json({ table: runtime.publicState(req.player.id) });
  });

  router.post('/', requireAuth(), async (req, res, next) => {
    try {
      const { small_blind: sb, big_blind: bb, table_size: size, name, mode } = req.body || {};
      const cleanName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : null;
      if (mode === 'coached_cash') {
        if (req.player.role !== 'coach') return res.status(403).json({ error: 'coach_only' });
        const runtime = await tableService.createCoachedTable({
          coach: req.player, smallBlind: sb, bigBlind: bb, tableSize: size, name: cleanName,
          defaultStack: Number.isInteger(req.body?.default_stack) ? req.body.default_stack : null,
        });
        return res.status(201).json({ table: runtime.publicState(req.player.id) });
      }
      const runtime = await tableService.createTable({
        creator: req.player,
        smallBlind: sb, bigBlind: bb, tableSize: size, name: cleanName,
      });
      res.status(201).json({
        table: runtime.publicState(req.player.id),
        buy_in: runtime.buyInBounds(),
      });
    } catch (err) {
      if (engineErrorToHttp(err, res)) return;
      next(err);
    }
  });

  // A lesson-synced scheduled table becomes joinable (M4 §1; coach-only).
  router.post('/:id/open', requireAuth(), async (req, res, next) => {
    try {
      if (req.player.role !== 'coach') return res.status(403).json({ error: 'coach_only' });
      const runtime = await tableService.openScheduled(req.params.id, req.player);
      res.json({ table: runtime.publicState(req.player.id) });
    } catch (err) {
      if (engineErrorToHttp(err, res)) return;
      next(err);
    }
  });

  // Coach ends the session — closes and exports it (RUNTIME §3).
  router.post('/:id/close', requireAuth(), async (req, res, next) => {
    try {
      if (req.player.role !== 'coach') return res.status(403).json({ error: 'coach_only' });
      const runtime = tableService.get(req.params.id);
      if (!runtime) return res.status(404).json({ error: 'not_found' });
      await tableService.closeTable(req.params.id, 'ended_by_coach');
      res.json({ closed: true });
    } catch (err) {
      if (engineErrorToHttp(err, res)) return;
      next(err);
    }
  });

  router.get('/:id', requireAuth(), (req, res) => {
    const runtime = tableService.get(req.params.id);
    if (!runtime || runtime.closed) return res.status(404).json({ error: 'not_found' });
    res.json({
      table: runtime.publicState(req.player.id),
      ...(runtime.buyInBounds ? { buy_in: runtime.buyInBounds() } : {}),
    });
  });

  router.post('/:id/join', requireAuth(), async (req, res, next) => {
    try {
      const runtime = tableService.get(req.params.id);
      if (!runtime || runtime.closed) return res.status(404).json({ error: 'not_found' });
      const { buy_in: buyIn, seat_index: seatIndex } = req.body || {};
      await runtime.join({
        player: req.player, buyIn,
        seatIndex: Number.isInteger(seatIndex) ? seatIndex : null,
      });
      res.status(201).json({ table: runtime.publicState(req.player.id) });
    } catch (err) {
      if (engineErrorToHttp(err, res)) return;
      next(err);
    }
  });

  router.post('/:id/rebuy', requireAuth(), async (req, res, next) => {
    try {
      const runtime = tableService.get(req.params.id);
      if (!runtime || runtime.closed) return res.status(404).json({ error: 'not_found' });
      await runtime.rebuy({ player: req.player, buyIn: (req.body || {}).buy_in });
      res.json({ table: runtime.publicState(req.player.id) });
    } catch (err) {
      if (engineErrorToHttp(err, res)) return;
      next(err);
    }
  });

  router.post('/:id/leave', requireAuth(), async (req, res, next) => {
    try {
      const runtime = tableService.get(req.params.id);
      if (!runtime) return res.status(404).json({ error: 'not_found' });
      const cashedOut = await runtime.leave(req.player.id);
      res.json({ cashed_out: cashedOut });
    } catch (err) {
      if (engineErrorToHttp(err, res)) return;
      next(err);
    }
  });

  return router;
}
