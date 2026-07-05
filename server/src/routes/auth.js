import { Router } from 'express';
import { signToken } from '../auth/tokens.js';
import {
  hashPassword, verifyPassword, validNewPassword, MIN_PASSWORD_LENGTH,
} from '../auth/passwords.js';
import { toPublicPlayer } from '../repos/playersRepo.js';

export function buildAuthRoutes({ playersRepo, requireAuth, config }) {
  const router = Router();

  router.post('/login', async (req, res, next) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: 'email_and_password_required' });
      }
      const player = await playersRepo.findByEmail(email);
      const ok = player && await verifyPassword(password, player.password_hash);
      if (!ok || player.status !== 'active') {
        return res.status(401).json({ error: 'invalid_credentials' });
      }
      res.json({ token: signToken(player, config), player: toPublicPlayer(player) });
    } catch (err) { next(err); }
  });

  router.post(
    '/change-password',
    requireAuth({ allowPendingPasswordChange: true }),
    async (req, res, next) => {
      try {
        const { current_password: current, new_password: fresh } = req.body || {};
        if (!current || !(await verifyPassword(current, req.player.password_hash))) {
          return res.status(401).json({ error: 'invalid_credentials' });
        }
        if (!validNewPassword(fresh)) {
          return res.status(400).json({
            error: 'weak_password',
            min_length: MIN_PASSWORD_LENGTH,
          });
        }
        const updated = await playersRepo.setPassword(
          req.player.id, await hashPassword(fresh), false
        );
        res.json({ player: toPublicPlayer(updated) });
      } catch (err) { next(err); }
    }
  );

  router.get(
    '/me',
    requireAuth({ allowPendingPasswordChange: true }),
    (req, res) => res.json({ player: toPublicPlayer(req.player) })
  );

  return router;
}
