import { describe, it, expect } from 'vitest';
import { TableEngine } from '../../src/game/TableEngine.js';
import { scriptedCardSourceFactory } from '../../src/game/cardSource.js';
import { computeCounters } from '../../src/game/counters.js';

// Acceptance #2: scripted hands with KNOWN counter outcomes assert every
// boolean. Hands are played through the real engine so the action log is
// authentic; counters are then computed from the completed record.

async function playHand({ seats, script, actions }) {
  let record = null;
  const engine = new TableEngine({
    config: { smallBlind: 50, bigBlind: 100, tableSize: 6 },
    cardSourceFactory: scriptedCardSourceFactory([script]),
    listener: (e) => { if (e.type === 'hand_complete') record = e.record; },
  });
  for (const s of seats) engine.seatPlayer(s);
  await engine.startHand();
  for (const [playerId, action] of actions) {
    await engine.act(playerId, action);
  }
  if (!record) throw new Error(`hand did not complete (phase ${engine.phase})`);
  return { record, counters: computeCounters(record) };
}

// Seats: a=BTN, b=SB, c=BB (3-handed, button starts at seat 0).
const THREE_SEATS = [
  { playerId: 'a', name: 'A', stack: 10000 },
  { playerId: 'b', name: 'B', stack: 10000 },
  { playerId: 'c', name: 'C', stack: 10000 },
];

describe('counter definitions against scripted hands', () => {
  it('open-raise + BB call + c-bet taken: vpip/pfr/cbet all correct', async () => {
    const { counters } = await playHand({
      seats: THREE_SEATS,
      script: {
        holeCards: { a: ['Ah', 'Kh'], b: ['7c', '2d'], c: ['Qs', 'Jd'] },
        board: ['2c', '7s', 'Th', '3d', '9c'],
      },
      actions: [
        ['a', { type: 'raise', amount: 300 }],  // BTN opens
        ['b', { type: 'fold' }],                // SB folds
        ['c', { type: 'call' }],                // BB defends
        // flop: c checks, a c-bets, c folds
        ['c', { type: 'check' }],
        ['a', { type: 'bet', amount: 400 }],
        ['c', { type: 'fold' }],
      ],
    });

    expect(counters.a).toEqual({
      vpip: true, pfr: true,
      three_bet_opp: false, three_bet: false,
      saw_flop: true, cbet_opp: true, cbet: true,
      wtsd: false, wsd: false,
    });
    expect(counters.b).toEqual({
      vpip: false, pfr: false,
      three_bet_opp: true, three_bet: false,  // faced one raise, folded
      saw_flop: false, cbet_opp: false, cbet: false,
      wtsd: false, wsd: false,
    });
    expect(counters.c).toEqual({
      vpip: true, pfr: false,
      three_bet_opp: true, three_bet: false,  // faced one raise, called
      saw_flop: true, cbet_opp: false, cbet: false,
      wtsd: false, wsd: false,
    });
  });

  it('3-bet taken; missed c-bet (aggressor checks flop); showdown reached', async () => {
    const { counters } = await playHand({
      seats: THREE_SEATS,
      script: {
        holeCards: { a: ['Ah', 'Kh'], b: ['Qc', 'Qd'], c: ['9s', '8d'] },
        board: ['2c', '7s', 'Th', '3d', '4c'],
      },
      actions: [
        ['a', { type: 'raise', amount: 300 }],   // open
        ['b', { type: 'raise', amount: 900 }],   // SB 3-bets (opp taken)
        ['c', { type: 'fold' }],                 // BB folds vs 3-bet (no opp: 2 raises)
        ['a', { type: 'call' }],
        // b is the last aggressor; postflop b acts first
        ['b', { type: 'check' }],                // missed c-bet (opp, not taken)
        ['a', { type: 'check' }],
        ['b', { type: 'check' }], ['a', { type: 'check' }],   // turn
        ['b', { type: 'check' }], ['a', { type: 'check' }],   // river → showdown
      ],
    });

    expect(counters.b.three_bet_opp).toBe(true);
    expect(counters.b.three_bet).toBe(true);
    expect(counters.b.pfr).toBe(true);
    expect(counters.b.cbet_opp).toBe(true);   // last aggressor, first to act
    expect(counters.b.cbet).toBe(false);      // checked instead
    expect(counters.c.three_bet_opp).toBe(false); // faced TWO raises at their turn
    expect(counters.a.three_bet_opp).toBe(false); // a made the first raise
    expect(counters.a.wtsd).toBe(true);
    expect(counters.b.wtsd).toBe(true);
    expect(counters.b.wsd).toBe(true);        // queens beat AK-high
    expect(counters.a.wsd).toBe(false);
  });

  it('limped pot: no preflop aggressor → nobody has a c-bet opp; BB check is not VPIP', async () => {
    const { counters } = await playHand({
      seats: THREE_SEATS,
      script: {
        holeCards: { a: ['5h', '5d'], b: ['7c', '6c'], c: ['Qs', 'Jd'] },
        board: ['2c', '7s', 'Th', '3d', '9c'],
      },
      actions: [
        ['a', { type: 'call' }],   // limp (VPIP)
        ['b', { type: 'call' }],   // SB complete (VPIP)
        ['c', { type: 'check' }],  // BB checks option (NOT VPIP)
        ['b', { type: 'check' }], ['c', { type: 'check' }], ['a', { type: 'check' }],
        ['b', { type: 'check' }], ['c', { type: 'check' }], ['a', { type: 'check' }],
        ['b', { type: 'check' }], ['c', { type: 'check' }], ['a', { type: 'check' }],
      ],
    });

    expect(counters.a.vpip).toBe(true);
    expect(counters.b.vpip).toBe(true);
    expect(counters.c.vpip).toBe(false);
    for (const p of ['a', 'b', 'c']) {
      expect(counters[p].pfr).toBe(false);
      expect(counters[p].cbet_opp).toBe(false);
      expect(counters[p].three_bet_opp).toBe(false); // no raise ever
      expect(counters[p].saw_flop).toBe(true);
      expect(counters[p].wtsd).toBe(true);
    }
  });

  it('donk bet denies the c-bet opportunity', async () => {
    const { counters } = await playHand({
      seats: THREE_SEATS,
      script: {
        holeCards: { a: ['Ah', 'Kh'], b: ['7c', '7d'], c: ['Qs', 'Jd'] },
        board: ['7s', '2c', 'Th', '3d', '9c'],
      },
      actions: [
        ['a', { type: 'raise', amount: 300 }],
        ['b', { type: 'call' }],
        ['c', { type: 'fold' }],
        ['b', { type: 'bet', amount: 500 }],  // donk into the aggressor
        ['a', { type: 'fold' }],
      ],
    });
    expect(counters.a.cbet_opp).toBe(false); // never got the chance
    expect(counters.a.cbet).toBe(false);
    expect(counters.b.cbet_opp).toBe(false); // b was not the aggressor
  });

  it('walk: everything false for everyone', async () => {
    const { counters, record } = await playHand({
      seats: THREE_SEATS,
      script: {},
      actions: [
        ['a', { type: 'fold' }],
        ['b', { type: 'fold' }],
      ],
    });
    expect(record.board).toEqual([]);
    for (const p of ['a', 'b', 'c']) {
      const c = counters[p];
      expect(c.saw_flop).toBe(false);
      expect(c.wtsd).toBe(false);
      expect(c.wsd).toBe(false);
      expect(c.cbet_opp).toBe(false);
    }
    expect(counters.c.vpip).toBe(false); // BB walked — not voluntary
    expect(counters.a.three_bet_opp).toBe(false);
    // b faced no raise (a folded), so no 3-bet opp either
    expect(counters.b.three_bet_opp).toBe(false);
  });
});
