import { Router } from 'express';

export function buildTablesRoutes({ tablesRepo, requireAuth }) {
  const router = Router();

  router.get('/', requireAuth(), async (req, res, next) => {
    try {
      res.json({ data: await tablesRepo.list() });
    } catch (err) { next(err); }
  });

  return router;
}
