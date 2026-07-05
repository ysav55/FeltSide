import { Router } from 'express';
import {
  hashPassword, validNewPassword, MIN_PASSWORD_LENGTH,
} from '../auth/passwords.js';
import { toPublicPlayer } from '../repos/playersRepo.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isUniqueViolation(err) {
  return err?.code === '23505' || /unique constraint/i.test(err?.message || '');
}

export function buildPlayersRoutes({ playersRepo, bankrollRepo, requireAuth, requireCoach }) {
  const router = Router();
  router.use(requireAuth(), requireCoach);

  router.get('/', async (req, res, next) => {
    try {
      res.json({ data: await playersRepo.list() });
    } catch (err) { next(err); }
  });

  router.post('/', async (req, res, next) => {
    try {
      const { display_name: displayName, email, initial_password: initial } = req.body || {};
      if (!displayName || !EMAIL_RE.test(email || '')) {
        return res.status(400).json({ error: 'invalid_display_name_or_email' });
      }
      if (!validNewPassword(initial)) {
        return res.status(400).json({
          error: 'weak_password',
          min_length: MIN_PASSWORD_LENGTH,
        });
      }
      const player = await playersRepo.create({
        displayName,
        email,
        passwordHash: await hashPassword(initial),
        role: 'player',
        ownerCoachId: req.player.id,
        mustChangePassword: true, // PRD §2: changeable at first login
      });
      await bankrollRepo.createAccount(player.id);
      res.status(201).json({ player: toPublicPlayer(player) });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return res.status(409).json({ error: 'email_taken' });
      }
      next(err);
    }
  });

  router.post('/:id/archive', async (req, res, next) => {
    try {
      const updated = await playersRepo.setStatus(req.params.id, 'archived');
      if (!updated) return res.status(404).json({ error: 'not_found' });
      res.json({ player: toPublicPlayer(updated) });
    } catch (err) { next(err); }
  });

  router.put('/:id/crm-student-id', async (req, res, next) => {
    try {
      const { crm_student_id: crmStudentId } = req.body || {};
      if (crmStudentId !== null && typeof crmStudentId !== 'string') {
        return res.status(400).json({ error: 'invalid_crm_student_id' });
      }
      const updated = await playersRepo.setCrmStudentId(
        req.params.id, crmStudentId || null
      );
      if (!updated) return res.status(404).json({ error: 'not_found' });
      res.json({ player: toPublicPlayer(updated) });
    } catch (err) { next(err); }
  });

  router.post('/:id/reset-password', async (req, res, next) => {
    try {
      const { new_password: fresh } = req.body || {};
      if (!validNewPassword(fresh)) {
        return res.status(400).json({
          error: 'weak_password',
          min_length: MIN_PASSWORD_LENGTH,
        });
      }
      const updated = await playersRepo.setPassword(
        req.params.id, await hashPassword(fresh), true
      );
      if (!updated) return res.status(404).json({ error: 'not_found' });
      res.json({ player: toPublicPlayer(updated) });
    } catch (err) { next(err); }
  });

  return router;
}
