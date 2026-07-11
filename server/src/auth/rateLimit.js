/**
 * Fixed-window in-memory rate limiter (M8.4 — /auth/* protection).
 *
 * In-memory is correct here: the engine is a single Fly machine (RUNTIME
 * §1), so there is no cross-instance state to share, and a restart
 * resetting the counters is harmless for a brute-force guard.
 */
export function buildRateLimiter({ windowMs, max, keyFn, now = Date.now }) {
  const hits = new Map(); // key → { windowStart, count }

  const middleware = (req, res, next) => {
    const t = now();
    const key = keyFn(req);
    let entry = hits.get(key);
    if (!entry || t - entry.windowStart >= windowMs) {
      entry = { windowStart: t, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfterSec = Math.ceil((entry.windowStart + windowMs - t) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'rate_limited', retry_after_sec: retryAfterSec });
    }
    // Opportunistic cleanup so the map never grows unbounded.
    if (hits.size > 10_000) {
      for (const [k, e] of hits) {
        if (t - e.windowStart >= windowMs) hits.delete(k);
      }
    }
    next();
  };
  middleware._reset = () => hits.clear(); // tests
  return middleware;
}

const clientIp = (req) =>
  // Fly terminates TLS and sets Fly-Client-IP; fall back to the socket.
  req.headers['fly-client-ip'] || req.ip || req.socket?.remoteAddress || 'unknown';

/**
 * Login limits, per minute:
 *   - per (IP, email): the brute-force guard — caps guesses against ONE
 *     account. Tight by design (default 10).
 *   - per IP: the credential-stuffing backstop — caps guesses across MANY
 *     accounts from one host. Generous by default (60) so a classroom of
 *     students behind one NAT'd school IP can all log in at lesson start.
 *
 * Both are env-tunable (AUTH_RL_PER_EMAIL / AUTH_RL_PER_IP) — load tests
 * raise them; production uses the defaults. A value of 0 disables that
 * limiter (documented ops knob, never the default).
 */
export function buildAuthRateLimits(opts = {}) {
  const perEmailMax = opts.perEmailMax ?? 10;
  const perIpMax = opts.perIpMax ?? 60;
  const limits = [];
  if (perIpMax > 0) {
    limits.push(buildRateLimiter({ windowMs: 60_000, max: perIpMax, keyFn: clientIp }));
  }
  if (perEmailMax > 0) {
    limits.push(buildRateLimiter({
      windowMs: 60_000,
      max: perEmailMax,
      keyFn: (req) => `${clientIp(req)}|${String(req.body?.email ?? '').toLowerCase()}`,
    }));
  }
  return limits;
}
