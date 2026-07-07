import { Router } from 'express';

/** Scenario library CRUD (PRD §4) — coach-only; ONE schema generation. */
export function buildScenariosRoutes({ scenariosRepo, requireAuth, requireCoach }) {
  const router = Router();
  router.use(requireAuth(), requireCoach);

  router.get('/', async (req, res, next) => {
    try {
      res.json({ data: await scenariosRepo.list() });
    } catch (err) { next(err); }
  });

  router.post('/', async (req, res, next) => {
    try {
      const { name, description = null, config } = req.body || {};
      if (typeof name !== 'string' || !name.trim() || typeof config !== 'object' || !config) {
        return res.status(400).json({ error: 'invalid_scenario' });
      }
      const row = await scenariosRepo.create({
        name: name.trim().slice(0, 120), description, config, createdBy: req.player.id,
      });
      res.status(201).json({ scenario: row });
    } catch (err) { next(err); }
  });

  router.put('/:id', async (req, res, next) => {
    try {
      const { name, description, config } = req.body || {};
      const row = await scenariosRepo.update(req.params.id, { name, description, config });
      if (!row) return res.status(404).json({ error: 'not_found' });
      res.json({ scenario: row });
    } catch (err) { next(err); }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const removed = await scenariosRepo.remove(req.params.id);
      if (!removed) return res.status(404).json({ error: 'not_found' });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  return router;
}
