import { Router } from 'express';

/** Playlist CRUD (PRD §4): ordered scenarios; exported by reference (§4.6). */
export function buildPlaylistsRoutes({ playlistsRepo, requireAuth, requireCoach }) {
  const router = Router();
  router.use(requireAuth(), requireCoach);

  router.get('/', async (req, res, next) => {
    try {
      res.json({ data: await playlistsRepo.list() });
    } catch (err) { next(err); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const playlist = await playlistsRepo.findById(req.params.id);
      if (!playlist) return res.status(404).json({ error: 'not_found' });
      const scenarios = await playlistsRepo.listScenarios(req.params.id);
      res.json({ playlist, scenarios });
    } catch (err) { next(err); }
  });

  router.post('/', async (req, res, next) => {
    try {
      const { name, description = null, scenario_ids: scenarioIds = [] } = req.body || {};
      if (typeof name !== 'string' || !name.trim() || !Array.isArray(scenarioIds)) {
        return res.status(400).json({ error: 'invalid_playlist' });
      }
      const row = await playlistsRepo.create({
        name: name.trim().slice(0, 120), description,
        createdBy: req.player.id, scenarioIds,
      });
      res.status(201).json({ playlist: row });
    } catch (err) { next(err); }
  });

  router.put('/:id', async (req, res, next) => {
    try {
      const { name, description, scenario_ids: scenarioIds } = req.body || {};
      const row = await playlistsRepo.update(req.params.id, { name, description });
      if (!row) return res.status(404).json({ error: 'not_found' });
      if (Array.isArray(scenarioIds)) {
        await playlistsRepo.setScenarios(req.params.id, scenarioIds);
      }
      res.json({ playlist: row });
    } catch (err) { next(err); }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const removed = await playlistsRepo.remove(req.params.id);
      if (!removed) return res.status(404).json({ error: 'not_found' });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  return router;
}
