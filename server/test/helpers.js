import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { seedCoach } from '../src/seed.js';

export const TEST_CONFIG = {
  port: 0,
  jwtSecret: 'test-secret',
  jwtExpiresIn: '1h',
  coachEmail: 'coach@test.local',
  coachInitialPassword: 'coach-secret-1',
  coachDisplayName: 'Test Coach',
  clientOrigin: 'http://localhost:5173',
};

/** Fresh in-process Postgres with the real migrations applied. */
export async function testDb() {
  const db = new PGlite();
  await migrate(db);
  return db;
}

export async function testApp() {
  const db = await testDb();
  const coach = await seedCoach(db, TEST_CONFIG);
  const app = createApp({ db, config: TEST_CONFIG });
  return { db, app, coach };
}

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
