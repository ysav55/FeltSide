import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { seedCoach } from '../src/seed.js';

export const TEST_CONFIG = {
  port: 0,
  exportApiKey: 'test-export-key',
  publicBaseUrl: 'https://engine.test',
  jwtSecret: 'test-secret',
  jwtExpiresIn: '1h',
  coachEmail: 'coach@test.local',
  coachInitialPassword: 'coach-secret-1',
  coachDisplayName: 'Test Coach',
  clientOrigin: 'http://localhost:5173',
  // Off by default so the existing suites aren't throttled; the dedicated
  // rate-limit test (auth.test.js) opts back in with an explicit config.
  authRateLimit: { perEmailMax: 0, perIpMax: 0 },
};

/** Fresh in-process Postgres with the real migrations applied. */
export async function testDb() {
  const db = new PGlite();
  await migrate(db);
  return db;
}

export async function testApp({ tableTimers, cardSourceFactory } = {}) {
  const db = await testDb();
  const coach = await seedCoach(db, TEST_CONFIG);
  const app = createApp({ db, config: TEST_CONFIG, tableTimers, cardSourceFactory });
  return { db, app, coach, tableService: app.locals.tableService, repos: app.locals.repos };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond, { timeoutMs = 3000, stepMs = 5 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await sleep(stepMs);
  }
  throw new Error('waitFor timed out');
}

/**
 * Drives one hand to completion: whenever it is someone's turn, asks
 * `strategy(playerId, legal, engine)` for the action. Waits for the hand
 * to start first, and for post-hand persistence to settle after.
 */
export async function driveHand(runtime, strategy) {
  await waitFor(() => runtime.engine.isHandRunning());
  while (runtime.engine.isHandRunning()) {
    const seatIdx = runtime.engine.toAct;
    if (seatIdx === null) { await sleep(2); continue; }
    const pid = runtime.engine.seats[seatIdx].playerId;
    const legal = runtime.engine.legalActions(pid);
    await runtime.act(pid, strategy(pid, legal, runtime.engine));
  }
  await runtime._enqueue(async () => {}); // barrier: recording + snapshot done
}

export const strategies = {
  /** Everyone calls/checks — hand always reaches showdown. */
  checkDown: (pid, legal) => (legal.check ? { type: 'check' } : { type: 'call' }),
  /** shover jams, caller calls everything, everyone else check/folds. */
  allInDuel: (shoverId, callerId) => (pid, legal) => {
    if (pid === shoverId) {
      if (legal.raise) return { type: 'raise', amount: legal.raise.maxTo };
      if (legal.bet) return { type: 'bet', amount: legal.bet.max };
      return legal.check ? { type: 'check' } : { type: 'call' };
    }
    if (pid === callerId) return legal.check ? { type: 'check' } : { type: 'call' };
    return legal.check ? { type: 'check' } : { type: 'fold' };
  },
};

export async function login(app, email, password) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email, password });
  return res;
}

export async function loginToken(app, email, password) {
  const res = await login(app, email, password);
  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status}`);
  }
  return res.body.token;
}

export async function createPlayer(app, coachToken, {
  displayName = 'Dana K',
  email = 'dana@test.local',
  initialPassword = 'initial-pass-1',
} = {}) {
  const res = await request(app)
    .post('/api/players')
    .set('Authorization', `Bearer ${coachToken}`)
    .send({ display_name: displayName, email, initial_password: initialPassword });
  return res;
}
