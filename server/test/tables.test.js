import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { testApp, loginToken } from './helpers.js';

let app; let db; let coach; let coachToken;

beforeEach(async () => {
  ({ app, db, coach } = await testApp());
  coachToken = await loginToken(app, 'coach@test.local', 'coach-secret-1');
});

describe('thin lobby tables list', () => {
  it('returns an empty list on a fresh install', async () => {
    const res = await request(app)
      .get('/api/tables')
      .set('Authorization', `Bearer ${coachToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('lists non-completed tables', async () => {
    await db.query(
      `insert into tables (mode, status, created_by) values
       ('uncoached_cash', 'open', $1),
       ('coached_cash', 'scheduled', $1),
       ('tournament', 'completed', $1)`,
      [coach.id]
    );
    const res = await request(app)
      .get('/api/tables')
      .set('Authorization', `Bearer ${coachToken}`);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((t) => t.status)).not.toContain('completed');
  });
});
