import { Router } from 'express';
import { signToken } from '../auth/tokens.js';
import {
  hashPassword, verifyPassword, validNewPassword, MIN_PASSWORD_LENGTH,
} from '../auth/passwords.js';
import { buildAuthRateLimits } from '../auth/rateLimit.js';
import { toPublicPlayer } from '../repos/playersRepo.js';
import { log } from '../log.js';

export function buildAuthRoutes({ playersRepo, requireAuth, config }) {
  const router = Router();

  // M8.4: brute-force guard on the credential surface. 429 with Retry-After;
  // limits are per-IP and per-(IP, email) so one student's typos never lock
  // out the school. Applied to POST /login and /change-password only — GET
  // /me is a cheap authenticated read and must stay responsive.
  const authLimits = buildAuthRateLimits(config.authRateLimit);
  for (const limit of authLimits) {
    router.post('/login', limit);
    router.post('/change-password', limit);
  }
  router._rateLimits = authLimits; // tests reset the windows

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
