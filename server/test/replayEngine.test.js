import { describe, it, expect } from 'vitest';
import { testApp } from './helpers.js';
import { scriptedCardSourceFactory } from '../src/game/cardSource.js';
import { buildReplay } from '../src/game/ReplayEngine.js';

// M6.1 acceptance — replay reconstruction property test: replaying the
// recorded actions reproduces stored stack_end and pot for 50 random
// recorded hands. Hands are produced by the REAL engine, then read back
// and reconstructed purely by ReplayEngine.

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['h', 'd', 'c', 's'];

/** A tiny seeded PRNG so the 50-hand sweep is deterministic. */
function mulberry32(seed) {
  return function rng() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Full 5-card board of distinct random cards, plus 2 hole cards per seat. */
function randomScript(rng, nSeats, seatIds) {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(`${r}${s}`);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  let c = 0;
  const holeCards = {};
  for (const id of seatIds) holeCards[id] = [deck[c++], deck[c++]];
  const board = deck.slice(c, c + 5);
  return { holeCards, board };
}

async function readHand(db, handId) {
  const { rows: [h] } = await db.query('select * from hands where id = $1', [handId]);
  const { rows: participants } = await db.query(
    `select player_id, position, hole_cards, stack_start, stack_end, is_winner
       from hand_participants where hand_id = $1`, [handId]);
  const { rows: actions } = await db.query(
    `select seq, player_id, street, action, amount, reverted
       from hand_actions where hand_id = $1 order by seq`, [handId]);
  return {
    handId,
    board: h.board,
    pot: Number(h.pot),
    origin: h.origin,
    revision: h.revision,
    participants: participants.map((p) => ({
      playerId: p.player_id, position: p.position,
      holeCards: p.hole_cards,
      stackStart: Number(p.stack_start), stackEnd: Number(p.stack_end),
      isWinner: p.is_winner,
    })),
    actions: actions.map((a) => ({
      seq: Number(a.seq), playerId: a.player_id, street: a.street,
      action: a.action, amount: Number(a.amount), reverted: a.reverted,
    })),
  };
}

describe('ReplayEngine — reconstruction property (50 recorded hands)', () => {
  it('replaying recorded actions reproduces stored stack_end and pot', async () => {
    const rng = mulberry32(20260707);
    const script = [];
    const { app, db, tableService } = await testApp({
      tableTimers: { interHandMs: 5, actionMs: 60_000, disconnectGraceMs: 60_000, retentionMs: 60_000, idleCloseMs: 600_000 },
      cardSourceFactory: scriptedCardSourceFactory(script),
    });
    const { loginToken, createPlayer, driveHand, strategies, waitFor } = await import('./helpers.js');
    const coachToken = await loginToken(app, 'coach@test.local', 'coach-secret-1');

    const ids = {};
    const tokens = {};
    for (const [name, email] of [['A', 'a@t.io'], ['B', 'b@t.io'], ['C', 'c@t.io']]) {
      const created = await createPlayer(app, coachToken, { displayName: name, email, initialPassword: 'initial-pass-1' });
      ids[name] = created.body.player.id;
      const { default: request } = await import('supertest');
      const login = await request(app).post('/api/auth/login').send({ email, password: 'initial-pass-1' });
      await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${login.body.token}`)
        .send({ current_password: 'initial-pass-1', new_password: 'passw0rd-x' });
      tokens[name] = login.body.token;
      await request(app).post(`/api/bankroll/${ids[name]}/adjust`).set('Authorization', `Bearer ${coachToken}`)
        .send({ delta: 5_000_000, note: 'roll' });
    }
    const seatIds = [ids.A, ids.B, ids.C];

    const { default: request } = await import('supertest');
    const created = await request(app).post('/api/tables').set('Authorization', `Bearer ${tokens.A}`)
      .send({ small_blind: 50, big_blind: 100, table_size: 6, name: 'Replay' });
    const tableId = created.body.table.tableId;
    for (const name of ['A', 'B', 'C']) {
      await request(app).post(`/api/tables/${tableId}/join`).set('Authorization', `Bearer ${tokens[name]}`)
        .send({ buy_in: 25_000 });
    }
    const runtime = tableService.get(tableId);

    let checked = 0;
    for (let hand = 0; hand < 50; hand++) {
      script[hand] = randomScript(rng, 3, seatIds);
      // Alternate check-downs and all-in duels for variety; both are fully
      // called → no uncalled refund, so reconstructed pot == stored pot.
      const strat = hand % 3 === 0
        ? strategies.allInDuel(seatIds[hand % 3], seatIds[(hand + 1) % 3])
        : strategies.checkDown;
      await waitFor(() => runtime.engine.canStartHand() || runtime.engine.isHandRunning());
      await driveHand(runtime, strat);

      const { rows } = await db.query('select id from hands order by played_at desc, id desc limit 1');
      const handId = rows[0].id;
      const detail = await readHand(db, handId);
      const replay = buildReplay(detail);

      // 1. Chip conservation across the whole hand.
      const sumStart = detail.participants.reduce((n, p) => n + p.stackStart, 0);
      const sumEnd = detail.participants.reduce((n, p) => n + p.stackEnd, 0);
      expect(sumStart).toBe(sumEnd);

      // 2. Reconstruct committed + pot from the action log alone.
      const { committed, stackBeforeAward, pot } = replay.reconstruct();

      // Stacks never go negative at any frame.
      for (const f of replay.frames) {
        for (const s of f.seats) expect(s.stack).toBeGreaterThanOrEqual(0);
      }

      // 3. Every NON-winner's reconstructed stack == stored stack_end.
      for (const p of detail.participants) {
        expect(stackBeforeAward[p.playerId]).toBe(p.stackStart - committed[p.playerId]);
        if (!p.isWinner) {
          expect(stackBeforeAward[p.playerId]).toBe(p.stackEnd);
        }
      }

      // 4. Winners collectively receive exactly the reconstructed pot.
      const winnerGain = detail.participants
        .filter((p) => p.isWinner)
        .reduce((n, p) => n + (p.stackEnd - stackBeforeAward[p.playerId]), 0);
      expect(winnerGain).toBe(pot);

      // 5. Fully-called hands (last action call/check) reproduce stored pot.
      const live = replay.frames[replay.frames.length - 1];
      const lastAct = live.lastAction;
      if (lastAct && (lastAct.action === 'call' || lastAct.action === 'check')) {
        expect(pot).toBe(detail.pot);
        checked += 1;
      }
    }
    // Sanity: the "reproduces stored pot exactly" branch actually exercised.
    expect(checked).toBeGreaterThan(20);

    await tableService.closeTable(tableId, 'done');
  }, 60_000);
});

describe('ReplayEngine — frame model', () => {
  it('reconstructs board/pot/toAct per step; jumps by seq and street; is immutable', () => {
    const hand = {
      handId: 'h1', origin: 'rng', revision: 1, pot: 400,
      board: ['Ah', 'Kd', '2c', '7s', '9h'],
      participants: [
        { playerId: 'p1', position: 'BTN', holeCards: ['As', 'Ks'], stackStart: 1000, stackEnd: 1400, isWinner: true },
        { playerId: 'p2', position: 'BB', holeCards: ['Qs', 'Qd'], stackStart: 1000, stackEnd: 600, isWinner: false },
      ],
      actions: [
        { seq: 1, playerId: 'p1', street: 'preflop', action: 'post_sb', amount: 50, reverted: false },
        { seq: 2, playerId: 'p2', street: 'preflop', action: 'post_bb', amount: 100, reverted: false },
        { seq: 3, playerId: 'p1', street: 'preflop', action: 'raise', amount: 300, reverted: false },
        { seq: 4, playerId: 'p2', street: 'preflop', action: 'call', amount: 200, reverted: false },
        { seq: 5, playerId: 'p2', street: 'flop', action: 'check', amount: 0, reverted: false },
        { seq: 6, playerId: 'p1', street: 'flop', action: 'check', amount: 0, reverted: false },
      ],
      tags: [{ tag: 'SINGLE_RAISED_POT', tag_type: 'descriptor', action_seq: null }],
    };
    const replay = buildReplay(hand);
    expect(replay.frameCount).toBe(7); // initial + 6 actions

    // Frame 0: nothing applied.
    expect(replay.frameAt(0).pot).toBe(0);
    expect(replay.frameAt(0).board).toEqual([]);
    expect(replay.frameAt(0).toAct).toBe('p1');

    // After both blinds + raise-to-300 + call: pot 600, preflop board empty.
    expect(replay.frameAt(4).pot).toBe(600);
    expect(replay.frameAt(4).board).toEqual([]);
    expect(replay.frameAt(4).seats.find((s) => s.playerId === 'p1').stack).toBe(700);
    expect(replay.frameAt(4).seats.find((s) => s.playerId === 'p2').stack).toBe(700);

    // Flop street: board reveals 3, betThisRound reset.
    expect(replay.frameAt(5).board).toEqual(['Ah', 'Kd', '2c']);
    expect(replay.frameAt(5).currentBet).toBe(0);

    // jump-by-seq and street cursors.
    expect(replay.cursorForSeq(3)).toBe(3);
    expect(replay.streetCursors().flop).toBe(5);

    // Immutability: frames are frozen; mutating a returned seat throws.
    expect(() => { replay.frameAt(4).seats[0].stack = 0; }).toThrow();
    expect(Object.isFrozen(replay.frames)).toBe(true);
  });

  it('skips reverted actions (undo timeline)', () => {
    const hand = {
      handId: 'h2', origin: 'rng', revision: 2, pot: 100,
      board: [], participants: [
        { playerId: 'p1', position: 'BTN', holeCards: ['As', 'Ks'], stackStart: 1000, stackEnd: 950, isWinner: false },
        { playerId: 'p2', position: 'BB', holeCards: ['Qs', 'Qd'], stackStart: 1000, stackEnd: 1050, isWinner: true },
      ],
      actions: [
        { seq: 1, playerId: 'p1', street: 'preflop', action: 'post_sb', amount: 50, reverted: false },
        { seq: 2, playerId: 'p2', street: 'preflop', action: 'post_bb', amount: 100, reverted: false },
        { seq: 3, playerId: 'p1', street: 'preflop', action: 'raise', amount: 300, reverted: true }, // undone
        { seq: 4, playerId: 'p1', street: 'preflop', action: 'fold', amount: 0, reverted: false },
      ],
    };
    const replay = buildReplay(hand);
    expect(replay.frameCount).toBe(4); // initial + 3 non-reverted
    expect(replay.frameAt(3).seats.find((s) => s.playerId === 'p1').folded).toBe(true);
    expect(replay.frameAt(3).pot).toBe(150); // blinds only; the 300 raise never happened
  });
});
