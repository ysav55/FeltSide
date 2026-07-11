import { Router } from 'express';

/**
 * Review & hand-history routes (M6 §§2-4, §7). Coach-only: hand detail is
 * open-kimono (all hole cards), so it is never exposed to players via HTTP —
 * players only ever see a review through the coach-driven group-review
 * socket path.
 *
 * Every retag mutation (add/remove coach tag, dismiss/undismiss auto tag)
 * bumps the hand revision, which re-stamps export_seq so the hand re-enters
 * the export stream exactly once (CONTRACT §4.5). Annotations are engine-side
 * only — NEVER exported (CONTRACT has no annotation field, M6 §3).
 */
export function buildReviewRoutes({ handReadRepo, recordingRepo, scenariosRepo, requireAuth, requireCoach }) {
  const router = Router();
  router.use(requireAuth(), requireCoach);

  // §7 — filterable hand-history browser.
  router.get('/', async (req, res, next) => {
    try {
      const { table_id, session_id, player_id, tag, origin, from, to, limit, offset } = req.query;
      const hands = await handReadRepo.listHands({
        tableId: table_id, sessionId: session_id, playerId: player_id,
        tag, origin, from, to,
        limit: Math.min(parseInt(limit, 10) || 50, 200),
        offset: parseInt(offset, 10) || 0,
      });
      res.json({ data: hands });
    } catch (err) { next(err); }
  });

  // §2 — full hand detail for replay.
  router.get('/:id', async (req, res, next) => {
    try {
      const detail = await handReadRepo.getHandDetail(req.params.id);
      if (!detail) return res.status(404).json({ error: 'not_found' });
      res.json({ hand: detail });
    } catch (err) { next(err); }
  });

  // §3 — annotations (engine-side only, not exported).
  router.post('/:id/annotations', async (req, res, next) => {
    try {
      if (!(await handReadRepo.handExists(req.params.id))) return res.status(404).json({ error: 'not_found' });
      const { action_index: actionIndex, body } = req.body || {};
      if (!Number.isInteger(actionIndex) || typeof body !== 'string' || !body.trim()) {
        return res.status(400).json({ error: 'invalid_annotation' });
      }
      const ann = await handReadRepo.addAnnotation(req.params.id, {
        actionIndex, body: body.trim().slice(0, 2000), createdBy: req.player.id,
      });
      res.status(201).json({ annotation: ann });
    } catch (err) { next(err); }
  });

  router.delete('/annotations/:annId', async (req, res, next) => {
    try {
      const removed = await handReadRepo.removeAnnotation(req.params.annId);
      if (!removed) return res.status(404).json({ error: 'not_found' });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // §4 — add a coach tag (bumps revision).
  router.post('/:id/tags', async (req, res, next) => {
    try {
      if (!(await handReadRepo.handExists(req.params.id))) return res.status(404).json({ error: 'not_found' });
      const { tag, player_id: playerId = null, action_seq: actionSeq = null } = req.body || {};
      if (typeof tag !== 'string' || !tag.trim()) return res.status(400).json({ error: 'invalid_tag' });
      await recordingRepo.addHandTags(req.params.id, [{
        tag: tag.trim().slice(0, 120), tag_type: 'coach', player_id: playerId, action_seq: actionSeq,
      }]);
      const hand = await bumpAndReturn(handReadRepo, recordingRepo, req.params.id);
      res.status(201).json({ hand });
    } catch (err) { next(err); }
  });

  // §4 — remove a coach tag (bumps revision). Auto tags are dismissed, not deleted.
  router.delete('/:id/tags/:tagId', async (req, res, next) => {
    try {
      const removed = await handReadRepo.removeCoachTag(req.params.tagId);
      if (!removed) return res.status(404).json({ error: 'not_found_or_not_coach_tag' });
      const hand = await bumpAndReturn(handReadRepo, recordingRepo, req.params.id);
      res.json({ hand });
    } catch (err) { next(err); }
  });

  // §4 — dismiss / restore an auto tag (bumps revision). Coach tags are removed, not dismissed.
  router.post('/:id/tags/:tagId/dismiss', async (req, res, next) => {
    try {
      const existing = await handReadRepo.getTag(req.params.tagId);
      if (!existing) return res.status(404).json({ error: 'not_found' });
      if (existing.tag_type === 'coach') return res.status(400).json({ error: 'coach_tag_use_delete' });
      const dismissed = req.body?.dismissed !== false; // default true
      await handReadRepo.setTagDismissed(req.params.tagId, dismissed);
      const hand = await bumpAndReturn(handReadRepo, recordingRepo, req.params.id);
      res.json({ hand });
    } catch (err) { next(err); }
  });

  // §7 — save a recorded hand as a scenario (playlist building starts here).
  router.post('/:id/save-scenario', async (req, res, next) => {
    try {
      const detail = await handReadRepo.getHandDetail(req.params.id);
      if (!detail) return res.status(404).json({ error: 'not_found' });
      const { name } = req.body || {};
      if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'invalid_name' });
      const config = scenarioFromHand(detail);
      const scenario = await scenariosRepo.create({
        name: name.trim().slice(0, 120), description: `From hand ${detail.handId}`,
        config, createdBy: req.player.id,
      });
      res.status(201).json({ scenario });
    } catch (err) { next(err); }
  });

  return router;
}

async function bumpAndReturn(handReadRepo, recordingRepo, handId) {
  await recordingRepo.bumpRevision(handId);
  return handReadRepo.getHandDetail(handId);
}

/**
 * Build an M4 scenario config (panel shape) from a recorded hand: assign
 * each participant's hole cards, pre-stage the board, manual street policy.
 * Reuses CoachedTableRuntime.applyScenario's shape exactly.
 */
function scenarioFromHand(detail) {
  const slots = {};
  for (const p of detail.participants) {
    if (p.holeCards && p.holeCards.length === 2) {
      slots[p.playerId] = { mode: 'cards', cards: [...p.holeCards] };
    }
  }
  const board = [0, 1, 2, 3, 4].map((i) => detail.board[i] ?? null);
  return {
    name: null,
    panel: {
      slots,
      board,
      streetPolicy: { flop: 'manual', turn: 'manual', river: 'manual' },
    },
    stacks: [],
  };
}
