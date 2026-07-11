import { describe, it, expect } from 'vitest';
import request from 'supertest';
import {
  testApp, loginToken, createPlayer, driveHand, strategies, waitFor, sleep,
} from './helpers.js';
import { scriptedCardSourceFactory } from '../src/game/cardSource.js';
import { TableService } from '../src/tables/TableService.js';

// Acceptance #3 — kill the server mid-hand; on boot the hand is voided:
// bets refunded (stacks = hand-start values), nothing recorded, and the
// next hand plays normally.

const ROYAL_BOARD = { board: ['As', 'Ks', 'Qs', 'Js', 'Ts'] };

describe('crash recovery (RUNTIME §1)', () => {
  it('voids the in-flight hand and resumes from the snapshot', async () => {
    const timers = {
      interHandMs: 25, actionMs: 60_000,
      disconnectGraceMs: 60_000, retentionMs: 60_000, idleCloseMs: 60_000,
    };
    const { app, db, repos, tableService } = await testApp({
      tableTimers: timers,
      cardSourceFactory: scriptedCardSourceFactory([ROYAL_BOARD]),
    });
    const coachToken = await loginToken(app, 'coach@test.local', 'coach-secret-1');

    const players = {};
    for (const [name, email] of [['A', 'a@t.io'], ['B', 'b@t.io']]) {
      const created = await createPlayer(app, coachToken, {
        displayName: name, email, initialPassword: 'initial-pass-1',
      });
      players[name] = created.body.player;
      await request(app).post(`/api/bankroll/${players[name].id}/adjust`)
        .set('Authorization', `Bearer ${coachToken}`).send({ delta: 50_000 });
    }

    // Seat both, play hand 1 to completion.
    const runtime = await tableService.createTable({
      creator: players.A, smallBlind: 50, bigBlind: 100, tableSize: 6,
    });
    const tableId = runtime.tableId;
    await runtime.join({ player: players.A, buyIn: 10_000 });
    await runtime.join({ player: players.B, buyIn: 10_000 });
    await driveHand(runtime, strategies.checkDown);

    const stacksAfterHand1 = Object.fromEntries(
      runtime.engine.occupiedSeats().map((s) => [s.playerId, s.stack])
    );

    // Hand 2 starts; A commits chips with a big raise, then we "crash".
    await waitFor(() => runtime.engine.isHandRunning());
    const firstToAct = runtime.engine.seats[runtime.engine.toAct].playerId;
    await runtime.act(firstToAct, { type: 'raise', amount: 2_000 });
    expect(runtime.engine.isHandRunning()).toBe(true);
    runtime.stop(); // the "kill": timers gone, in-memory state abandoned

    // ── Boot: a fresh service over the same database ──────────────────
    const revived = new TableService({
      repos, timers,
      cardSourceFactory: scriptedCardSourceFactory([ROYAL_BOARD]),
    });
    const recoveredCount = await revived.recover();
    expect(recoveredCount).toBe(1);
    const revivedRuntime = revived.get(tableId);

    // Bets refunded: stacks are exactly the post-hand-1 snapshot values.
    for (const seat of revivedRuntime.engine.occupiedSeats()) {
      expect(seat.stack).toBe(stacksAfterHand1[seat.playerId]);
      expect(seat.contributed).toBe(0);
    }

    // The voided hand was never written.
    const handCount = async () => Number((await db.query(
      `select count(*)::int as n from hands h
        join sessions s on s.id = h.session_id where s.table_id = $1`,
      [tableId]
    )).rows[0].n);
    expect(await handCount()).toBe(1);

    // Bankrolls untouched by the void (only the two buy-ins exist).
    const { rows: txs } = await db.query(
      `select type, count(*)::int as n from bankroll_transactions
        where ref_id = $1 group by type`, [tableId]
    );
    expect(txs).toEqual([{ type: 'buy_in', n: 2 }]);

    // The next hand plays normally on the revived table and gets recorded.
    await driveHand(revivedRuntime, strategies.checkDown);
    expect(await handCount()).toBe(2);
    // Same open session continues — no duplicate session row.
    const { rows: sessions } = await db.query(
      `select * from sessions where table_id = $1`, [tableId]
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('open');

    revivedRuntime.stop();
    await sleep(5);
  }, 20_000);
});
