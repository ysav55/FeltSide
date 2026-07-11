import { verifyToken } from './tokens.js';

// THE single enforcement path (PRD §2 anti-goal: no parallel systems).
// Every protected route uses requireAuth; coach-only routes add requireCoach.

export function buildAuthMiddleware({ config, playersRepo }) {
  /**
   * requireAuth() — standard protected route.
   * requireAuth({ allowPendingPasswordChange: true }) — the two routes a
   * player with must_change_password may still reach (me, change-password).
   */
  function requireAuth({ allowPendingPasswordChange = false } = {}) {
    return async (req, res, next) => {
      try {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'unauthenticated' });

        let payload;
        try {
          payload = verifyToken(token, config);
        } catch {
          return res.status(401).json({ error: 'invalid_token' });
        }

        // Fresh load so archival/role changes take effect immediately.
        const player = await playersRepo.findById(payload.sub);
        if (!player || player.status !== 'active') {
          return res.status(401).json({ error: 'unauthenticated' });
        }
        if (player.must_change_password && !allowPendingPasswordChange) {
          return res.status(403).json({ error: 'password_change_required' });
        }

        req.player = player;
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  function requireCoach(req, res, next) {
    if (!req.player || req.player.role !== 'coach') {
      return res.status(403).json({ error: 'coach_only' });
    }
    next();
  }

  return { requireAuth, requireCoach };
}
