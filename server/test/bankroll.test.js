import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { testApp, login, loginToken, createPlayer } from './helpers.js';
import { buildBankrollRepo } from '../src/repos/bankrollRepo.js';

let app; let db; let coachToken; let playerId; let playerToken;

beforeEach(async () => {
  ({ app, db } = await testApp());
  coachToken = await loginToken(app, 'coach@test.local', 'coach-secret-1');
  const created = await createPlayer(app, coachToken);
  playerId = created.body.player.id;
  playerToken = (await login(app, 'dana@test.local', 'initial-pass-1')).body.token;
  await request(app)
    .post('/api/auth/change-password')
    .set('Authorization', `Bearer ${playerToken}`)
    .send({ current_password: 'initial-pass-1', new_password: 'my-new-pass-1' });
});

const adjust = (body) => request(app)
  .post(`/api/bankroll/${playerId}/adjust`)
  .set('Authorization', `Bearer ${coachToken}`)
  .send(body);

describe('bankroll ledger (M1 acceptance #3)', () => {
  it('adjustments apply atomically and are visible to coach and player', async () => {
    const res = await adjust({ delta: 5000, note: 'starting roll' });
    expect(res.status).toBe(201);
    expect(Number(res.body.transaction.balance_after)).toBe(5000);

    const own = await request(app)
      .get('/api/bankroll/me')
      .set('Authorization', `Bearer ${playerToken}`);
    expect(own.status).toBe(200);
    expect(own.body.balance).toBe(5000);
    expect(own.body.transactions).toHaveLength(1);
    expect(own.body.transactions[0].note).toBe('starting roll');

    const coachView = await request(app)
      .get(`/api/bankroll/${playerId}`)
      .set('Authorization', `Bearer ${coachToken}`);
    expect(coachView.body.balance).toBe(5000);
  });

  it('reset-to-X is computed as a delta; the log stays append-only', async () => {
    await adjust({ delta: 5000 });
    const reset = await adjust({ reset_to: 2000, note: 'reset for drill' });
    expect(reset.status).toBe(201);
    expect(Number(reset.body.transaction.amount)).toBe(-3000);
    expect(Number(reset.body.transaction.balance_after)).toBe(2000);

    const repo = buildBankrollRepo(db);
    expect(await repo.getBalance(playerId)).toBe(2000);
    expect(await repo.sumTransactions(playerId)).toBe(2000);
  });

  it('balance == sum(transactions) after concurrent adjustments', async () => {
    const repo = buildBankrollRepo(db);
    await adjust({ delta: 10000 });

    const deltas = [
      250, -100, 500, -250, 1000, -750, 300, -300, 125, -125,
      600, -200, 450, -450, 80, -80, 999, -999, 42, -42,
    ];
    await Promise.all(deltas.map((d) => adjust({ delta: d })));

    const balance = await repo.getBalance(playerId);
    const sum = await repo.sumTransactions(playerId);
    expect(balance).toBe(sum);
    expect(balance).toBe(10000 + deltas.reduce((a, b) => a + b, 0));
  });

  it('a negative balance is impossible (CHECK constraint)', async () => {
    await adjust({ delta: 100 });
    const res = await adjust({ delta: -101 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('insufficient_balance');

    const repo = buildBankrollRepo(db);
    expect(await repo.getBalance(playerId)).toBe(100); // unchanged
    expect(await repo.sumTransactions(playerId)).toBe(100); // no orphan tx
  });

  it('rejects malformed adjustments', async () => {
    expect((await adjust({})).status).toBe(400);
    expect((await adjust({ delta: 10, reset_to: 20 })).status).toBe(400);
    expect((await adjust({ reset_to: -5 })).status).toBe(400);
    expect((await adjust({ delta: 1.5 })).status).toBe(400);
  });

  it('player can view own account but not adjust or view others', async () => {
    const own = await request(app)
      .get('/api/bankroll/me')
      .set('Authorization', `Bearer ${playerToken}`);
    expect(own.status).toBe(200);

    const forbidden = await request(app)
      .post(`/api/bankroll/${playerId}/adjust`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ delta: 1000000 });
    expect(forbidden.status).toBe(403);
  });
});
