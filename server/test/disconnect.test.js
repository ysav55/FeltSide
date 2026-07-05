import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { testApp, loginToken, createPlayer, waitFor } from './helpers.js';

// Acceptance #4 — disconnect → auto sit-out at grace → auto cash-out at
// retention, ledger correct. Timers run in milliseconds here.

async function twoSeatedPlayers(tableService, app, coachToken) {
  const players = {};
  for (const [name, email] of [['A', 'a@t.io'], ['B', 'b@t.io']]) {
    const created = await createPlayer(app, coachToken, {
      displayName: name, email, initialPassword: 'initial-pass-1',
    });
    players[name] = created.body.player;
    await request(app).post(`/api/bankroll/${players[name].id}/adjust`)
      .set('Authorization', `Bearer ${coachToken}`).send({ delta: 50_000 });
  }
  const runtime = await tableService.createTable({
    creator: players.A, smallBlind: 50, bigBlind: 100, tableSize: 6,
  });
  await runtime.join({ player: players.A, buyIn: 10_000 });
  await runtime.join({ player: players.B, buyIn: 10_000 });
  return { players, runtime };
}

describe('disconnect lifecycle (RUNTIME §2–3)', () => {
  it('grace → sit-out; retention → cash-out and seat release', async () => {
    const { app, db, tableService } = await testApp({
      tableTimers: {
        interHandMs: 600_000, actionMs: 600_000, // no hands during this test
        disconnectGraceMs: 40, retentionMs: 120, idleCloseMs: 600_000,
      },
    });
    const coachToken = await loginToken(app, 'coach@test.local', 'coach-secret-1');
    const { players, runtime } = await twoSeatedPlayers(tableService, app, coachToken);

    runtime.playerConnected(players.A.id);
    runtime.playerConnected(players.B.id);
    runtime.playerDisconnected(players.B.id);

    // 60s-equivalent grace: B is sat out but the seat is retained.
    await waitFor(() => runtime.engine.findSeat(players.B.id)?.sittingOut === true);
    expect(runtime.engine.findSeat(players.B.id)).not.toBeNull();

    // 5min-equivalent retention: stack safely banked, seat released.
    await waitFor(() => runtime.engine.findSeat(players.B.id) === null);
    const { rows } = await db.query(
      `select type, amount from bankroll_transactions
        where player_id = $1 and ref_id = $2 order by created_at`,
      [players.B.id, runtime.tableId]
    );
    expect(rows.map((r) => [r.type, Number(r.amount)])).toEqual([
      ['buy_in', -10_000],
      ['cash_out', 10_000],
    ]);

    // Reconnect within grace cancels the timers for the other player.
    runtime.playerDisconnected(players.A.id);
    runtime.playerConnected(players.A.id); // back before grace expires
    await new Promise((r) => setTimeout(r, 80));
    expect(runtime.engine.findSeat(players.A.id)?.sittingOut).toBe(false);
    runtime.stop();
  }, 15_000);

  it('idle table (zero connected players) closes and cashes everyone out', async () => {
    const { app, db, tableService } = await testApp({
      tableTimers: {
        interHandMs: 600_000, actionMs: 600_000,
        disconnectGraceMs: 600_000, retentionMs: 600_000, idleCloseMs: 60,
      },
    });
    const coachToken = await loginToken(app, 'coach@test.local', 'coach-secret-1');
    const { players, runtime } = await twoSeatedPlayers(tableService, app, coachToken);
    // Nobody ever connects a socket → idle close fires.
    await waitFor(() => runtime.closed === true);

    const { rows } = await db.query(
      `select status from tables where id = $1`, [runtime.tableId]
    );
    expect(rows[0].status).toBe('completed');

    for (const p of [players.A, players.B]) {
      const { rows: net } = await db.query(
        `select coalesce(sum(amount), 0)::bigint as net
           from bankroll_transactions where player_id = $1 and ref_id = $2`,
        [p.id, runtime.tableId]
      );
      expect(Number(net[0].net)).toBe(0); // bought in, cashed back out
    }
  }, 15_000);
});
