import { Router } from 'express';
import { buildContractAuth } from './contractAuth.js';
import { parseSnapshot, reconcileLessons } from '../sync/lessonSync.js';

/**
 * PUT /sync/v1/lessons (CONTRACT §8) — the one inbound channel. Same static
 * API key as the export side; contract error dialect ({ code }).
 * Success is 204: the CRM treats a bodyless 2xx as a completed push.
 */
export function buildSyncRoutes({ db, tablesRepo, config }) {
  const router = Router();
  router.use(buildContractAuth(config));

  router.put('/lessons', async (req, res, next) => {
    try {
      const entries = parseSnapshot(req.body);
      if (entries === null) {
        return res.status(400).json({ code: 'invalid_snapshot' });
      }
      await reconcileLessons({ db, tablesRepo, entries });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  return router;
}
