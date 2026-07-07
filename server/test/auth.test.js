import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { testApp, testDb, TEST_CONFIG, login, loginToken, createPlayer } from './helpers.js';
import { createApp } from '../src/app.js';
import { seedCoach } from '../src/seed.js';
import { buildRateLimiter } from '../src/auth/rateLimit.js';

let app;
beforeEach(async () => {
  ({ app } = await testApp());
});

describe('coach seeding + login', () => {
  it('seeds the coach from env and lets them log in', async () => {
    const res = await login(app, 'coach@test.local', 'coach-secret-1');
    expect(res.status).toBe(200);
    expect(res.body.player.role).toBe('coach');
    expect(res.body.player.password_hash).toBeUndefined();
    expect(res.body.token).toBeTruthy();
  });

  it('rejects bad credentials', async () => {
    const res = await login(app, 'coach@test.local', 'wrong');
    expect(res.status).toBe(401);
  });
});

describe('player lifecycle (M1 acceptance #2)', () => {
  let coachToken;
  beforeEach(async () => {
    coachToken = await loginToken(app, 'coach@test.local', 'coach-secret-1');
  });

  it('coach creates a player; player logs in; forced change works', async () => {
    const created = await createPlayer(app, coachToken);
    expect(created.status).toBe(201);
    expect(created.body.player.must_change_password).toBe(true);

    const first = await login(app, 'dana@test.local', 'initial-pass-1');
    expect(first.status).toBe(200);
    expect(first.body.player.must_change_password).toBe(true);
    const playerToken = first.body.token;

    // Blocked from normal routes until the password is changed…
    const blocked = await request(app)
      .get('/api/tables')
      .set('Authorization', `Bearer ${playerToken}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('password_change_required');

    // …but can change it…
    const change = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ current_password: 'initial-pass-1', new_password: 'my-new-pass-1' });
    expect(change.status).toBe(200);
    expect(change.body.player.must_change_password).toBe(false);

    // …after which normal routes open up and the new password works.
    const open = await request(app)
      .get('/api/tables')
      .set('Authorization', `Bearer ${playerToken}`);
    expect(open.status).toBe(200);
    expect((await login(app, 'dana@test.local', 'my-new-pass-1')).status).toBe(200);
    expect((await login(app, 'dana@test.local', 'initial-pass-1')).status).toBe(401);
  });

  it('player cannot reach coach endpoints (403), unauthenticated cannot reach anything (401)', async () => {
    await createPlayer(app, coachToken);
    const playerToken = (await login(app, 'dana@test.local', 'initial-pass-1')).body.token;
    await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ current_password: 'initial-pass-1', new_password: 'my-new-pass-1' });

    for (const [method, path] of [
      ['get', '/api/players'],
      ['post', '/api/players'],
      ['post', '/api/players/00000000-0000-0000-0000-000000000000/archive'],
      ['put', '/api/players/00000000-0000-0000-0000-000000000000/crm-student-id'],
      ['post', '/api/players/00000000-0000-0000-0000-000000000000/reset-password'],
      ['post', '/api/bankroll/00000000-0000-0000-0000-000000000000/adjust'],
      ['get', '/api/bankroll/00000000-0000-0000-0000-000000000000'],
    ]) {
      const res = await request(app)[method](path)
        .set('Authorization', `Bearer ${playerToken}`)
        .send({});
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('archived player can no longer authenticate', async () => {
    const created = await createPlayer(app, coachToken);
    const playerToken = (await login(app, 'dana@test.local', 'initial-pass-1')).body.token;

    await request(app)
      .post(`/api/players/${created.body.player.id}/archive`)
      .set('Authorization', `Bearer ${coachToken}`);

    expect((await login(app, 'dana@test.local', 'initial-pass-1')).status).toBe(401);
    const withOldToken = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${playerToken}`);
    expect(withOldToken.status).toBe(401);
  });

  it('coach can set, clear crm_student_id and reset a password', async () => {
    const created = await createPlayer(app, coachToken);
    const id = created.body.player.id;

    const set = await request(app)
      .put(`/api/players/${id}/crm-student-id`)
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ crm_student_id: 'stu_01HTEST' });
    expect(set.body.player.crm_student_id).toBe('stu_01HTEST');

    const clear = await request(app)
      .put(`/api/players/${id}/crm-student-id`)
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ crm_student_id: null });
    expect(clear.body.player.crm_student_id).toBeNull();

    const reset = await request(app)
      .post(`/api/players/${id}/reset-password`)
      .set('Authorization', `Bearer ${coachToken}`)
      .send({ new_password: 'issued-again-1' });
    expect(reset.status).toBe(200);
    expect(reset.body.player.must_change_password).toBe(true);
    expect((await login(app, 'dana@test.local', 'issued-again-1')).status).toBe(200);
  });

  it('duplicate email is rejected with 409', async () => {
    await createPlayer(app, coachToken);
    const dup = await createPlayer(app, coachToken);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('email_taken');
  });
});

describe('every API endpoint rejects unauthenticated requests (M1 acceptance #4)', () => {
  it('401 across the surface', async () => {
    for (const [method, path] of [
      ['get', '/api/auth/me'],
      ['post', '/api/auth/change-password'],
      ['get', '/api/players'],
      ['post', '/api/players'],
      ['get', '/api/tables'],
      ['get', '/api/bankroll/me'],
      ['get', '/api/bankroll/00000000-0000-0000-0000-000000000000'],
      ['post', '/api/bankroll/00000000-0000-0000-0000-000000000000/adjust'],
    ]) {
      const res = await request(app)[method](path).send({});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ── M8.4 security pass ──────────────────────────────────────────────────
describe('auth rate limiting (M8.4)', () => {
  /** App with the brute-force guard turned on (tight for a deterministic test). */
  async function limitedApp({ perEmailMax = 5, perIpMax = 100 } = {}) {
    const db = await testDb();
    await seedCoach(db, TEST_CONFIG);
    const config = { ...TEST_CONFIG, authRateLimit: { perEmailMax, perIpMax } };
    return createApp({ db, config });
  }

  it('locks a single account after N bad attempts, with Retry-After, then 429s further tries', async () => {
    const a = await limitedApp({ perEmailMax: 5 });
    // 5 allowed (all 401 bad creds), 6th is throttled.
    for (let i = 0; i < 5; i++) {
      const r = await login(a, 'coach@test.local', 'wrong');
      expect(r.status, `attempt ${i + 1}`).toBe(401);
    }
    const blocked = await login(a, 'coach@test.local', 'wrong');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.body.retry_after_sec).toBeGreaterThan(0);

    // Even the CORRECT password is refused while the window is hot — the
    // guard is on the attempt rate, not the outcome.
    const correctButLocked = await login(a, 'coach@test.local', 'coach-secret-1');
    expect(correctButLocked.status).toBe(429);
  });

  it('one account being hammered does not lock a different account from the same IP', async () => {
    const a = await limitedApp({ perEmailMax: 3, perIpMax: 100 });
    for (let i = 0; i < 4; i++) await login(a, 'victim@test.local', 'x');
    // A different email is still served (per-email bucket is independent).
    const other = await login(a, 'coach@test.local', 'coach-secret-1');
    expect(other.status).toBe(200);
  });

  it('the per-IP backstop caps total attempts across many accounts', async () => {
    const a = await limitedApp({ perEmailMax: 0, perIpMax: 5 });
    for (let i = 0; i < 5; i++) {
      const r = await login(a, `stuff${i}@test.local`, 'x');
      expect(r.status).toBe(401); // distinct emails, so per-email never trips
    }
    const blocked = await login(a, 'stuff-final@test.local', 'x');
    expect(blocked.status).toBe(429); // per-IP backstop
  });

  it('a fixed window resets after it elapses (injected clock)', () => {
    let t = 1_000_000;
    const limiter = buildRateLimiter({ windowMs: 1000, max: 2, keyFn: () => 'k', now: () => t });
    const run = () => {
      let status = 200;
      limiter({ headers: {}, body: {} }, {
        status: (s) => { status = s; return { json: () => {}, set: () => {} }; },
        set: () => {},
      }, () => {});
      return status;
    };
    expect(run()).toBe(200);
    expect(run()).toBe(200);
    expect(run()).toBe(429);   // over the max
    t += 1001;                 // next window
    expect(run()).toBe(200);   // reset
  });
});

describe('JWT expiry + re-auth (M8.4)', () => {
  it('an expired token is rejected as unauthenticated', async () => {
    const { app: a } = await testApp();
    const player = { id: '00000000-0000-0000-0000-000000000000', role: 'coach' };
    // Sign a token that expired an hour ago against the test secret.
    const expired = jwt.sign({ sub: player.id, role: player.role }, TEST_CONFIG.jwtSecret, {
      expiresIn: '-1h',
    });
    const res = await request(a).get('/api/auth/me').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  it('a token signed with the wrong secret is rejected', async () => {
    const { app: a } = await testApp();
    const forged = jwt.sign({ sub: 'x', role: 'coach' }, 'not-the-secret', { expiresIn: '1h' });
    const res = await request(a).get('/api/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });
});
