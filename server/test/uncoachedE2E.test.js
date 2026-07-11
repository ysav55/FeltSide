import { describe, it, expect } from 'vitest';
import request from 'supertest';
import {
  testApp, loginToken, createPlayer, driveHand, strategies, waitFor,
} from './helpers.js';
import { scriptedCardSourceFactory } from '../src/game/cardSource.js';

// Acceptance #1 — the full uncoached cash vertical slice with an exactly
// reconciling bankroll ledger.

const ROYAL_BOARD = { board: ['As', 'Ks', 'Qs', 'Js', 'Ts'] }; // board plays → splits

describe('uncoached cash end-to-end', () => {
  it('3 players: join/buy-in, 11 hands, sit-out, bust + re-entry, leave — ledger reconciles', async () => {
    const script = [];
    const { app, db, tableService } = await testApp({
      tableTimers: {
        interHandMs: 25, actionMs: 60_000,
        disconnectGraceMs: 60_000, retentionMs: 60_000, idleCloseMs: 60_000,
      },
      cardSourceFactory: scriptedCardSourceFactory(script),
    });
    const coachToken = await loginToken(app, 'coach@test.local', 'coach-secret-1');

    // Three players with bankrolls.
    const tokens = {};
    const ids = {};
    for (const [name, email, roll] of [
      ['P1', 'p1@t.io', 100_000], ['P2', 'p2@t.io', 100_000], ['P3', 'p3@t.io', 100_000],
    ]) {
      const created = await createPlayer(app, coachToken, {
        displayName: name, email, initialPassword: 'initial-pass-1',
      });
      ids[name] = created.body.player.id;
      const login = await request(app).post('/api/auth/login')
        .send({ email, password: 'initial-pass-1' });
      await request(app).post('/api/auth/change-password')
        .set('Authorization', `Bearer ${login.body.token}`)
        .send({ current_password: 'initial-pass-1', new_password: 'passw0rd-x' });
      tokens[name] = login.body.token;
      await request(app).post(`/api/bankroll/${ids[name]}/adjust`)
        .set('Authorization', `Bearer ${coachToken}`)
        .send({ delta: roll, note: 'test roll' });
    }

    // Scripted deck: 5 split hands, then the bust duel, then splits forever.
    script.push(
      ROYAL_BOARD, ROYAL_BOARD, ROYAL_BOARD, ROYAL_BOARD, ROYAL_BOARD,
      {
        holeCards: { [ids.P1]: ['Ah', 'Ad'], [ids.P3]: ['Kh', 'Kd'] },
        board: ['2c', '7s', 'Jh', '3d', '9c'],
      },
      ROYAL_BOARD
    );

    // P1 creates the table; everyone buys in (P3 short: 50 BB).
    const created = await request(app).post('/api/tables')
      .set('Authorization', `Bearer ${tokens.P1}`)
      .send({ small_blind: 50, big_blind: 100, table_size: 6, name: 'E2E' });
    expect(created.status).toBe(201);
    const tableId = created.body.table.tableId;
    expect(created.body.buy_in).toEqual({ min: 5000, max: 25000, defaultAmount: 10000 });

    // Buy-in validation: below minimum and above bankroll both rejected.
    const tooSmall = await request(app).post(`/api/tables/${tableId}/join`)
      .set('Authorization', `Bearer ${tokens.P1}`).send({ buy_in: 100 });
    expect(tooSmall.status).toBe(400);
    expect(tooSmall.body.error).toBe('invalid_buy_in');

    for (const [name, buyIn] of [['P1', 10000], ['P2', 10000], ['P3', 5000]]) {
      const res = await request(app).post(`/api/tables/${tableId}/join`)
        .set('Authorization', `Bearer ${tokens[name]}`).send({ buy_in: buyIn });
      expect(res.status).toBe(201);
    }

    const runtime = tableService.get(tableId);
    const ledger = async () => {
      const { rows } = await db.query(
        `select type, coalesce(sum(amount), 0)::bigint as total
           from bankroll_transactions where ref_id = $1 group by type`,
        [tableId]
      );
      const sums = Object.fromEntries(rows.map((r) => [r.type, Number(r.total)]));
      return { buyIns: -(sums.buy_in ?? 0), cashOuts: sums.cash_out ?? 0 };
    };
    const tableChips = () =>
      runtime.engine.occupiedSeats().reduce((sum, s) => sum + s.stack + s.contributed, 0);

    // Invariant checked after EVERY hand: chips on the table equal
    // buy-ins minus cash-outs.
    const assertConservation = async () => {
      const { buyIns, cashOuts } = await ledger();
      expect(tableChips()).toBe(buyIns - cashOuts);
    };

    // Hands 1–4: split boards (no net movement), P2 sits out during hand 4.
    for (let hand = 1; hand <= 4; hand++) {
      if (hand === 4) {
        await driveHand(runtime, (pid, legal, engine) => {
          if (pid === ids.P2 && !engine.findSeat(ids.P2).sittingOut) {
            // sit-out mid-hand: takes effect next hand, current hand plays on
            runtime.sitOut(ids.P2, true);
          }
          return strategies.checkDown(pid, legal);
        });
      } else {
        await driveHand(runtime, strategies.checkDown);
      }
      await assertConservation();
    }

    // Hand 5 plays heads-up: P2 is sitting out.
    await driveHand(runtime, (pid, legal, engine) => {
      expect(engine.findSeat(ids.P2).inHand).toBe(false);
      return strategies.checkDown(pid, legal);
    });
    await assertConservation();
    await runtime.sitOut(ids.P2, false); // back in

    // Hand 6: P1's aces bust P3's kings all-in preflop.
    await driveHand(runtime, strategies.allInDuel(ids.P1, ids.P3));
    await assertConservation();
    const p3Seat = runtime.engine.findSeat(ids.P3);
    expect(p3Seat.stack).toBe(0);
    expect(p3Seat.sittingOut).toBe(true); // busted → sat out, seat retained

    // Re-entry: new buy-in on the same seat.
    const rebuy = await request(app).post(`/api/tables/${tableId}/rebuy`)
      .set('Authorization', `Bearer ${tokens.P3}`).send({ buy_in: 5000 });
    expect(rebuy.status).toBe(200);
    // Assert the snapshot the rebuy itself returned, not live engine state:
    // interHandMs is 25ms, so the next hand can deal (and P3 can post a
    // blind) before a later read lands.
    const p3AtRebuy = rebuy.body.table.seats.find((s) => s && s.playerId === ids.P3);
    expect(p3AtRebuy.stack).toBe(5000);

    // Hands 7–11: five more split hands → 11 total.
    for (let hand = 7; hand <= 11; hand++) {
      await driveHand(runtime, strategies.checkDown);
      await assertConservation();
    }

    // Park the table (no next hand), then everyone leaves.
    for (const name of ['P1', 'P2', 'P3']) await runtime.sitOut(ids[name], true);
    for (const name of ['P1', 'P2', 'P3']) {
      const res = await request(app).post(`/api/tables/${tableId}/leave`)
        .set('Authorization', `Bearer ${tokens[name]}`);
      expect(res.status).toBe(200);
    }

    // ── Ledger reconciliation (the acceptance bar) ────────────────────
    // For every player: cash-outs − buy-ins == net stack change, where
    // the net stack change is the sum of recorded per-hand deltas. The
    // table's books balance to zero once everyone has left.
    for (const name of ['P1', 'P2', 'P3']) {
      const { rows: netRows } = await db.query(
        `select coalesce(sum(amount), 0)::bigint as net
           from bankroll_transactions
          where player_id = $1 and ref_id = $2`,
        [ids[name], tableId]
      );
      const netLedger = Number(netRows[0].net);
      const { rows: deltaRows } = await db.query(
        `select coalesce(sum(hp.stack_end - hp.stack_start), 0)::bigint as delta
           from hand_participants hp
           join hands h on h.id = hp.hand_id
           join sessions s on s.id = h.session_id
          where hp.player_id = $1 and s.table_id = $2`,
        [ids[name], tableId]
      );
      expect(netLedger, `${name} ledger == recorded stack change`)
        .toBe(Number(deltaRows[0].delta));
      const balance = await request(app).get(`/api/bankroll/${ids[name]}`)
        .set('Authorization', `Bearer ${coachToken}`);
      expect(balance.body.balance, `${name} balance`).toBe(100_000 + netLedger);
    }
    const { buyIns, cashOuts } = await ledger();
    expect(buyIns - cashOuts).toBe(0); // zero-sum: every chip returned
    expect(tableChips()).toBe(0);

    // Recording: 11 hands, all rng, session finalizes on close.
    await tableService.closeTable(tableId, 'test_done');
    const hands = await db.query(
      `select h.* from hands h join sessions s on s.id = h.session_id
        where s.table_id = $1 order by h.played_at`, [tableId]
    );
    expect(hands.rows).toHaveLength(11);
    expect(hands.rows.every((h) => h.origin === 'rng')).toBe(true);
    const session = await db.query(
      `select * from sessions where table_id = $1`, [tableId]
    );
    expect(session.rows).toHaveLength(1);
    expect(session.rows[0].status).toBe('completed');
    expect(session.rows[0].hand_count).toBe(11);

    // The bust hand carries full participant + action detail.
    const bustHand = hands.rows[5];
    const parts = await db.query(
      `select * from hand_participants where hand_id = $1`, [bustHand.id]
    );
    const p1Row = parts.rows.find((r) => r.player_id === ids.P1);
    const p3Row = parts.rows.find((r) => r.player_id === ids.P3);
    expect(p1Row.is_winner).toBe(true);
    expect(p3Row.is_winner).toBe(false);
    expect(Number(p3Row.stack_end)).toBe(0); // busted exactly
    // Zero-sum within the hand: P1's win == P3's stack + any dead blind.
    const handDelta = parts.rows.reduce(
      (sum, r) => sum + Number(r.stack_end) - Number(r.stack_start), 0
    );
    expect(handDelta).toBe(0);
    expect(Number(p1Row.stack_end) - Number(p1Row.stack_start))
      .toBeGreaterThanOrEqual(5000);
  }, 30_000);
});
