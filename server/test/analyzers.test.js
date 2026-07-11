import { describe, it, expect, vi } from 'vitest';
import { analyzeHand } from '../src/analyzers/index.js';
import { headsUpEquity } from '../src/analyzers/equity.js';

// M4/M5 acceptance B — golden analyzer tests: every tag's trigger AND
// non-trigger case, over hand-record fixtures (pure, no DB).

const P1 = 'p1', P2 = 'p2', P3 = 'p3';

let seq = 0;
const a = (playerId, street, action, amount = 0, extra = {}) =>
  ({ seq: ++seq, playerId, street, action, amount, allIn: false, reverted: false, ...extra });

function rec({
  actions, participants, board = [], winners = [],
  showdownReached = false, origin = 'rng', undoUsed = false,
}) {
  seq = 0;
  return {
    handNo: 1, origin, board, pot: 0,
    actions: actions(), participants, winners, showdownReached,
    showdown: null, undoUsed,
  };
}

/** Heads-up shell: P1 BTN(SB), P2 BB. */
const HU = (over = {}) => [
  { playerId: P1, position: 'BTN', holeCards: ['Ah', 'Kd'], folded: false, ...over[P1] },
  { playerId: P2, position: 'BB', holeCards: ['9c', '9d'], folded: false, ...over[P2] },
];
/** 3-handed: P1 BTN, P2 SB, P3 BB. */
const THREE = (over = {}) => [
  { playerId: P1, position: 'BTN', holeCards: ['Ah', 'Kd'], folded: false, ...over[P1] },
  { playerId: P2, position: 'SB', holeCards: ['7h', '2d'], folded: false, ...over[P2] },
  { playerId: P3, position: 'BB', holeCards: ['9c', '9d'], folded: false, ...over[P3] },
];

const blinds = (sb, bb) => [a(sb, 'preflop', 'post_sb', 50), a(bb, 'preflop', 'post_bb', 100)];
const has = (tags, name, playerId) =>
  tags.some((t) => t.tag === name && (playerId === undefined || t.player_id === playerId));
const tagOf = (tags, name) => tags.find((t) => t.tag === name);

describe('§1 hand-level descriptors', () => {
  it('pot type: limped / single-raised / 3-bet / 4-bet, squeeze', () => {
    const limped = analyzeHand(rec({
      participants: HU(),
      actions: () => [...blinds(P1, P2), a(P1, 'preflop', 'call', 50), a(P2, 'preflop', 'check')],
    }));
    expect(has(limped, 'LIMPED_POT')).toBe(true);
    expect(has(limped, 'SINGLE_RAISED_POT')).toBe(false);

    const single = analyzeHand(rec({
      participants: HU(),
      actions: () => [...blinds(P1, P2), a(P1, 'preflop', 'raise', 300), a(P2, 'preflop', 'call', 200)],
    }));
    expect(has(single, 'SINGLE_RAISED_POT')).toBe(true);
    expect(has(single, 'LIMPED_POT')).toBe(false);

    const threeBet = analyzeHand(rec({
      participants: HU(),
      actions: () => [...blinds(P1, P2),
        a(P1, 'preflop', 'raise', 300), a(P2, 'preflop', 'raise', 900), a(P1, 'preflop', 'call', 600)],
    }));
    expect(has(threeBet, 'THREE_BET_POT')).toBe(true);

    const fourBet = analyzeHand(rec({
      participants: HU(),
      actions: () => [...blinds(P1, P2),
        a(P1, 'preflop', 'raise', 300), a(P2, 'preflop', 'raise', 900),
        a(P1, 'preflop', 'raise', 2200), a(P2, 'preflop', 'fold')],
    }));
    expect(has(fourBet, 'FOUR_BET_POT')).toBe(true);

    // Squeeze: open + caller + 3-bet.
    const squeeze = analyzeHand(rec({
      participants: THREE(),
      actions: () => [...blinds(P2, P3),
        a(P1, 'preflop', 'raise', 300), a(P2, 'preflop', 'call', 250),
        a(P3, 'preflop', 'raise', 1200), a(P1, 'preflop', 'fold'), a(P2, 'preflop', 'fold')],
    }));
    expect(has(squeeze, 'SQUEEZE_POT')).toBe(true);
    expect(has(threeBet, 'SQUEEZE_POT')).toBe(false); // no caller between
  });

  it('ALLIN_PREFLOP, MULTIWAY, WALK', () => {
    const allin = analyzeHand(rec({
      participants: HU(),
      board: ['2c', '7s', 'Jh', '3d', '9s'],
      showdownReached: true, winners: [P1],
      actions: () => [...blinds(P1, P2),
        a(P1, 'preflop', 'raise', 10000, { allIn: true }),
        a(P2, 'preflop', 'call', 9900, { allIn: true })],
    }));
    expect(has(allin, 'ALLIN_PREFLOP')).toBe(true);

    const multiway = analyzeHand(rec({
      participants: THREE(),
      board: ['2c', '7s', 'Jh'],
      actions: () => [...blinds(P2, P3),
        a(P1, 'preflop', 'call', 100), a(P2, 'preflop', 'call', 50), a(P3, 'preflop', 'check'),
        a(P2, 'flop', 'check'), a(P3, 'flop', 'check'), a(P1, 'flop', 'check')],
    }));
    expect(has(multiway, 'MULTIWAY')).toBe(true);
    expect(has(allin, 'MULTIWAY')).toBe(false);

    const walk = analyzeHand(rec({
      participants: THREE(),
      winners: [P3],
      actions: () => [...blinds(P2, P3), a(P1, 'preflop', 'fold'), a(P2, 'preflop', 'fold')],
    }));
    expect(has(walk, 'WALK')).toBe(true);
    expect(has(multiway, 'WALK')).toBe(false);
  });

  it('board texture family', () => {
    const mono = analyzeHand(rec({
      participants: HU(), board: ['Ah', '7h', '2h'],
      actions: () => [...blinds(P1, P2), a(P1, 'preflop', 'call', 50), a(P2, 'preflop', 'check')],
    }));
    expect(has(mono, 'BOARD_MONOTONE')).toBe(true);
    expect(has(mono, 'BOARD_ACE_HIGH')).toBe(true);
    expect(has(mono, 'BOARD_TWO_TONE')).toBe(false);

    const connected = analyzeHand(rec({
      participants: HU(), board: ['9h', '8d', '6c'],
      actions: () => [...blinds(P1, P2), a(P1, 'preflop', 'call', 50), a(P2, 'preflop', 'check')],
    }));
    expect(has(connected, 'BOARD_CONNECTED')).toBe(true);
    expect(has(connected, 'BOARD_RAINBOW')).toBe(true);

    const paired = analyzeHand(rec({
      participants: HU(), board: ['Kh', 'Kd', '2c'],
      actions: () => [...blinds(P1, P2), a(P1, 'preflop', 'call', 50), a(P2, 'preflop', 'check')],
    }));
    expect(has(paired, 'BOARD_PAIRED')).toBe(true);
    expect(has(paired, 'BOARD_CONNECTED')).toBe(false); // paired excluded
  });

  it('UNDO_USED is a descriptor tied to the flag', () => {
    const base = {
      participants: HU(),
      actions: () => [...blinds(P1, P2), a(P1, 'preflop', 'fold')],
      winners: [P2],
    };
    expect(has(analyzeHand(rec({ ...base, undoUsed: true })), 'UNDO_USED')).toBe(true);
    expect(has(analyzeHand(rec(base)), 'UNDO_USED')).toBe(false);
  });
});

describe('§2 player-level descriptors', () => {
  const cbetLine = (last) => () => [...blinds(P1, P2),
    a(P1, 'preflop', 'raise', 300), a(P2, 'preflop', 'call', 200),
    a(P2, 'flop', 'check'), a(P1, 'flop', 'bet', 400), a(P2, 'flop', 'call', 400),
    ...(last >= 2 ? [a(P2, 'turn', 'check'), a(P1, 'turn', 'bet', 900), a(P2, 'turn', 'call', 900)] : []),
    ...(last >= 3 ? [a(P2, 'river', 'check'), a(P1, 'river', 'bet', 2000), a(P2, 'river', 'fold')] : []),
  ];

  it('CBET_FLOP → DOUBLE_BARREL → TRIPLE_BARREL, with action_seq', () => {
    const tags = analyzeHand(rec({
      participants: HU(), board: ['2c', '7s', 'Jh', '3d', '9s'], winners: [P1],
      actions: cbetLine(3),
    }));
    expect(tagOf(tags, 'CBET_FLOP')?.player_id).toBe(P1);
    expect(tagOf(tags, 'CBET_FLOP')?.action_seq).toBe(6);
    expect(has(tags, 'DOUBLE_BARREL', P1)).toBe(true);
    expect(has(tags, 'TRIPLE_BARREL', P1)).toBe(true);

    const flopOnly = analyzeHand(rec({
      participants: HU(), board: ['2c', '7s', 'Jh'], winners: [P1],
      actions: cbetLine(1),
    }));
    expect(has(flopOnly, 'DOUBLE_BARREL')).toBe(false);
  });

  it('DONK_BET kills the c-bet opportunity and fires itself', () => {
    const tags = analyzeHand(rec({
      participants: HU(), board: ['2c', '7s', 'Jh'], winners: [P2],
      actions: () => [...blinds(P1, P2),
        a(P1, 'preflop', 'raise', 300), a(P2, 'preflop', 'call', 200),
        a(P2, 'flop', 'bet', 300), a(P1, 'flop', 'fold')],
    }));
    expect(has(tags, 'DONK_BET', P2)).toBe(true);
    expect(has(tags, 'CBET_FLOP')).toBe(false);
  });

  it('CHECK_RAISE and RIVER_RAISE', () => {
    const tags = analyzeHand(rec({
      participants: HU(), board: ['2c', '7s', 'Jh', '3d', '9s'], winners: [P2],
      actions: () => [...blinds(P1, P2),
        a(P1, 'preflop', 'raise', 300), a(P2, 'preflop', 'call', 200),
        a(P2, 'flop', 'check'), a(P1, 'flop', 'bet', 400), a(P2, 'flop', 'raise', 1200), a(P1, 'flop', 'call', 800),
        a(P2, 'turn', 'check'), a(P1, 'turn', 'check'),
        a(P2, 'river', 'bet', 1000), a(P1, 'river', 'raise', 3000), a(P2, 'river', 'call', 2000)],
      showdownReached: true,
    }));
    expect(has(tags, 'CHECK_RAISE', P2)).toBe(true);
    expect(has(tags, 'RIVER_RAISE', P1)).toBe(true);
    expect(has(tags, 'CHECK_RAISE', P1)).toBe(false);
  });

  it('PROBE_BET: OOP bets turn after the aggressor checked back the flop', () => {
    const tags = analyzeHand(rec({
      participants: HU(), board: ['2c', '7s', 'Jh', '3d'], winners: [P2],
      actions: () => [...blinds(P1, P2),
        a(P1, 'preflop', 'raise', 300), a(P2, 'preflop', 'call', 200),
        a(P2, 'flop', 'check'), a(P1, 'flop', 'check'),
        a(P2, 'turn', 'bet', 400), a(P1, 'turn', 'fold')],
    }));
    expect(has(tags, 'PROBE_BET', P2)).toBe(true);
    // Not a probe when the flop had a bet.
    const noProbe = analyzeHand(rec({
      participants: HU(), board: ['2c', '7s', 'Jh', '3d'], winners: [P2],
      actions: () => [...blinds(P1, P2),
        a(P1, 'preflop', 'raise', 300), a(P2, 'preflop', 'call', 200),
        a(P2, 'flop', 'check'), a(P1, 'flop', 'bet', 300), a(P2, 'flop', 'call', 300),
        a(P2, 'turn', 'bet', 400), a(P1, 'turn', 'fold')],
    }));
    expect(has(noProbe, 'PROBE_BET')).toBe(false);
  });

  it('LIMP_RERAISE and MIN_RAISE_POSTFLOP', () => {
    const tags = analyzeHand(rec({
      participants: THREE(), winners: [P2],
      actions: () => [...blinds(P2, P3),
        a(P1, 'preflop', 'call', 100),            // limp
        a(P2, 'preflop', 'raise', 500),
        a(P3, 'preflop', 'fold'),
        a(P1, 'preflop', 'raise', 1500),          // limp-reraise
        a(P2, 'preflop', 'fold')],
    }));
    expect(has(tags, 'LIMP_RERAISE', P1)).toBe(true);

    const minRaise = analyzeHand(rec({
      participants: HU(), board: ['2c', '7s', 'Jh'], winners: [P1],
      actions: () => [...blinds(P1, P2),
        a(P1, 'preflop', 'raise', 300), a(P2, 'preflop', 'call', 200),
        a(P2, 'flop', 'bet', 400), a(P1, 'flop', 'raise', 800),  // exactly min
        a(P2, 'flop', 'fold')],
    }));
    expect(has(minRaise, 'MIN_RAISE_POSTFLOP', P1)).toBe(true);
    const bigRaise = analyzeHand(rec({
      participants: HU(), board: ['2c', '7s', 'Jh'], winners: [P1],
      actions: () => [...blinds(P1, P2),
        a(P1, 'preflop', 'raise', 300), a(P2, 'preflop', 'call', 200),
        a(P2, 'flop', 'bet', 400), a(P1, 'flop', 'raise', 1200),
        a(P2, 'flop', 'fold')],
    }));
    expect(has(bigRaise, 'MIN_RAISE_POSTFLOP')).toBe(false);
  });

  it('ALLIN_FAVORITE / UNDERDOG on AA vs KK; ALLIN_FLIP on AKs vs QQ', () => {
    const aaVsKk = rec({
      participants: HU({ [P1]: { holeCards: ['As', 'Ad'] }, [P2]: { holeCards: ['Ks', 'Kd'] } }),
      board: ['2c', '7s', 'Jh', '3d', '9s'], showdownReached: true, winners: [P1],
      actions: () => [...blinds(P1, P2),
        a(P1, 'preflop', 'raise', 10000, { allIn: true }),
        a(P2, 'preflop', 'call', 9900, { allIn: true })],
    });
    const tags = analyzeHand(aaVsKk);
    expect(has(tags, 'ALLIN_FAVORITE', P1)).toBe(true);
    expect(has(tags, 'ALLIN_UNDERDOG', P2)).toBe(true);

    const flip = analyzeHand(rec({
      participants: HU({ [P1]: { holeCards: ['Ah', 'Kh'] }, [P2]: { holeCards: ['Qs', 'Qd'] } }),
      board: ['2c', '7s', 'Jh', '3d', '9s'], showdownReached: true, winners: [P2],
      actions: () => [...blinds(P1, P2),
        a(P1, 'preflop', 'raise', 10000, { allIn: true }),
        a(P2, 'preflop', 'call', 9900, { allIn: true })],
    }));
    expect(has(flip, 'ALLIN_FLIP', P1)).toBe(true);
    expect(has(flip, 'ALLIN_FLIP', P2)).toBe(true);

    // No all-in call → no ALLIN_* tags.
    expect(analyzeHand(rec({
      participants: HU(),
      actions: () => [...blinds(P1, P2), a(P1, 'preflop', 'fold')],
      winners: [P2],
    })).filter((t) => t.tag.startsWith('ALLIN_'))).toEqual([]);
  });

  it('FOLDED_WINNER: river fold beating every shown-down hand', () => {
    const tags = analyzeHand(rec({
      participants: [
        { playerId: P1, position: 'BTN', holeCards: ['Ah', 'Jd'], folded: true },  // top pair, folds
        { playerId: P2, position: 'SB', holeCards: ['7h', '7d'], folded: false },
        { playerId: P3, position: 'BB', holeCards: ['2h', '2d'], folded: false },
      ],
      board: ['Jh', '5s', '9c', '3d', '8s'], showdownReached: true, winners: [P2],
      actions: () => [...blinds(P2, P3),
        a(P1, 'preflop', 'call', 100), a(P2, 'preflop', 'call', 50), a(P3, 'preflop', 'check'),
        a(P2, 'flop', 'check'), a(P3, 'flop', 'check'), a(P1, 'flop', 'check'),
        a(P2, 'turn', 'check'), a(P3, 'turn', 'check'), a(P1, 'turn', 'check'),
        a(P2, 'river', 'bet', 300), a(P3, 'river', 'call', 300), a(P1, 'river', 'fold')],
    }));
    expect(has(tags, 'FOLDED_WINNER', P1)).toBe(true);

    // Folding the worst hand is not FOLDED_WINNER.
    const worst = analyzeHand(rec({
      participants: [
        { playerId: P1, position: 'BTN', holeCards: ['4h', '6d'], folded: true },
        { playerId: P2, position: 'SB', holeCards: ['7h', '7d'], folded: false },
        { playerId: P3, position: 'BB', holeCards: ['Jc', 'Td'], folded: false },
      ],
      board: ['Jh', '5s', '9c', '3d', '8s'], showdownReached: true, winners: [P3],
      actions: () => [...blinds(P2, P3),
        a(P1, 'preflop', 'call', 100), a(P2, 'preflop', 'call', 50), a(P3, 'preflop', 'check'),
        a(P2, 'flop', 'check'), a(P3, 'flop', 'check'), a(P1, 'flop', 'check'),
        a(P2, 'turn', 'check'), a(P3, 'turn', 'check'), a(P1, 'turn', 'check'),
        a(P2, 'river', 'bet', 300), a(P3, 'river', 'call', 300), a(P1, 'river', 'fold')],
    }));
    expect(has(worst, 'FOLDED_WINNER')).toBe(false);
  });
});

describe('§3 absolute mistakes', () => {
  it('OPEN_LIMP vs OVERLIMP', () => {
    const tags = analyzeHand(rec({
      participants: THREE(), winners: [P3],
      actions: () => [...blinds(P2, P3),
        a(P1, 'preflop', 'call', 100),   // open limp
        a(P2, 'preflop', 'call', 50),    // overlimp (SB complete behind a limper)
        a(P3, 'preflop', 'check')],
    }));
    expect(has(tags, 'OPEN_LIMP', P1)).toBe(true);
    expect(has(tags, 'OVERLIMP', P2)).toBe(true);
    // A raiser is neither.
    const raised = analyzeHand(rec({
      participants: HU(), winners: [P1],
      actions: () => [...blinds(P1, P2), a(P1, 'preflop', 'raise', 300), a(P2, 'preflop', 'fold')],
    }));
    expect(has(raised, 'OPEN_LIMP')).toBe(false);
  });

  it('COLD_CALL_3BET only for cold callers (blinds and invested players exempt)', () => {
    const tags = analyzeHand(rec({
      participants: [
        { playerId: P1, position: 'CO', holeCards: ['Ah', 'Kd'], folded: false },
        { playerId: P2, position: 'BTN', holeCards: ['Qs', 'Qd'], folded: false },
        { playerId: P3, position: 'BB', holeCards: ['9c', '9d'], folded: false },
      ],
      winners: [P1],
      actions: () => [
        a(P3, 'preflop', 'post_bb', 100),
        a(P1, 'preflop', 'raise', 300),   // open
        a(P2, 'preflop', 'raise', 900),   // 3-bet
        a(P3, 'preflop', 'call', 800),    // BB caller — NOT cold (blind money)
        a(P1, 'preflop', 'call', 600),    // opener — NOT cold (invested)
      ],
    }));
    expect(has(tags, 'COLD_CALL_3BET')).toBe(false);

    const cold = rec({
      participants: [
        { playerId: P1, position: 'CO', holeCards: ['Ah', 'Kd'], folded: false },
        { playerId: P2, position: 'BTN', holeCards: ['Qs', 'Qd'], folded: false },
        { playerId: P3, position: 'SB', holeCards: ['9c', '9d'], folded: false },
      ],
      winners: [P1],
      actions: () => [
        a(P1, 'preflop', 'raise', 300),
        a(P2, 'preflop', 'raise', 900),
        a(P3, 'preflop', 'fold'),
      ],
    });
    // 4th player cold-calls the 3-bet.
    cold.actions.push({ seq: 99, playerId: 'p4', street: 'preflop', action: 'call', amount: 900, allIn: false, reverted: false });
    cold.participants.push({ playerId: 'p4', position: 'BTN', holeCards: ['Jh', 'Js'], folded: false });
    const coldTags = analyzeHand(cold);
    expect(has(coldTags, 'COLD_CALL_3BET', 'p4')).toBe(true);
  });

  it('MISSED_RIVER_VALUE: in-position river check-back with two pair+', () => {
    const base = (hole) => rec({
      participants: HU({ [P1]: { holeCards: hole } }),
      board: ['Ah', 'Kh', '2c', '7d', '3s'], showdownReached: true, winners: [P1],
      actions: () => [...blinds(P1, P2),
        a(P1, 'preflop', 'raise', 300), a(P2, 'preflop', 'call', 200),
        a(P2, 'flop', 'check'), a(P1, 'flop', 'check'),
        a(P2, 'turn', 'check'), a(P1, 'turn', 'check'),
        a(P2, 'river', 'check'), a(P1, 'river', 'check')],   // P1 checks BEHIND
    });
    expect(has(analyzeHand(base(['Ad', 'Kd'])), 'MISSED_RIVER_VALUE', P1)).toBe(true); // two pair
    expect(has(analyzeHand(base(['Ad', 'Qd'])), 'MISSED_RIVER_VALUE')).toBe(false);   // one pair
    // A bet on the river → nobody "checked back".
    const betRiver = rec({
      participants: HU({ [P1]: { holeCards: ['Ad', 'Kd'] } }),
      board: ['Ah', 'Kh', '2c', '7d', '3s'], showdownReached: true, winners: [P1],
      actions: () => [...blinds(P1, P2),
        a(P1, 'preflop', 'raise', 300), a(P2, 'preflop', 'call', 200),
        a(P2, 'flop', 'check'), a(P1, 'flop', 'check'),
        a(P2, 'turn', 'check'), a(P1, 'turn', 'check'),
        a(P2, 'river', 'check'), a(P1, 'river', 'bet', 500), a(P2, 'river', 'fold')],
    });
    expect(has(analyzeHand(betRiver), 'MISSED_RIVER_VALUE')).toBe(false);
  });
});

describe('§4 chart mistakes', () => {
  const utgOpen = (hole, action) => rec({
    participants: [
      { playerId: P1, position: 'UTG', holeCards: hole, folded: action === 'fold' },
      { playerId: P2, position: 'SB', holeCards: ['5h', '5d'], folded: false },
      { playerId: P3, position: 'BB', holeCards: ['9c', '9d'], folded: false },
    ],
    winners: [P3],
    actions: () => [...blinds(P2, P3),
      action === 'fold' ? a(P1, 'preflop', 'fold') : a(P1, 'preflop', 'raise', 300),
      a(P2, 'preflop', 'fold'), a(P3, 'preflop', 'check')],
  });

  it('OPEN_TOO_LOOSE on an off-chart open; not on a chart open', () => {
    expect(has(analyzeHand(utgOpen(['7h', '2d'], 'raise')), 'OPEN_TOO_LOOSE', P1)).toBe(true);
    expect(has(analyzeHand(utgOpen(['Ah', 'Ad'], 'raise')), 'OPEN_TOO_LOOSE', P1)).toBe(false);
  });

  it('OPEN_TOO_TIGHT on a folded chart hand (folds are judgeable)', () => {
    expect(has(analyzeHand(utgOpen(['Ah', 'Ad'], 'fold')), 'OPEN_TOO_TIGHT', P1)).toBe(true);
    // 72o folded first-in is correct play, not a tagged mistake — for P1.
    // (P2 in this fixture folds 55 in the SB, which IS its own valid tag.)
    expect(has(analyzeHand(utgOpen(['7h', '2d'], 'fold')), 'OPEN_TOO_TIGHT', P1)).toBe(false);
  });

  const bbVsBtn = (hole, action) => rec({
    participants: [
      { playerId: P1, position: 'BTN', holeCards: ['Ah', 'Qd'], folded: false },
      { playerId: P2, position: 'SB', holeCards: ['5h', '4d'], folded: true },
      { playerId: P3, position: 'BB', holeCards: hole, folded: action === 'fold' },
    ],
    winners: [P1],
    actions: () => [...blinds(P2, P3),
      a(P1, 'preflop', 'raise', 250),
      a(P2, 'preflop', 'fold'),
      action === 'fold' ? a(P3, 'preflop', 'fold') : a(P3, 'preflop', 'call', 150)],
  });

  it('BB_OVERFOLD inside the defend chart; BLIND_OVERDEFEND outside it', () => {
    expect(has(analyzeHand(bbVsBtn(['Ah', '9s'], 'fold')), 'BB_OVERFOLD', P3)).toBe(true);   // A9o defends vs BTN
    expect(has(analyzeHand(bbVsBtn(['7h', '2d'], 'fold')), 'BB_OVERFOLD')).toBe(false);
    expect(has(analyzeHand(bbVsBtn(['7h', '2d'], 'call')), 'BLIND_OVERDEFEND', P3)).toBe(true);
    expect(has(analyzeHand(bbVsBtn(['Ah', '9s'], 'call')), 'BLIND_OVERDEFEND')).toBe(false);
  });

  it('SB_OVERFOLD uses the SB defend chart', () => {
    const sbFold = rec({
      participants: [
        { playerId: P1, position: 'BTN', holeCards: ['Ah', 'Qd'], folded: false },
        { playerId: P2, position: 'SB', holeCards: ['As', 'Th'], folded: true }, // ATo defends vs BTN
        { playerId: P3, position: 'BB', holeCards: ['7c', '2d'], folded: true },
      ],
      winners: [P1],
      actions: () => [...blinds(P2, P3),
        a(P1, 'preflop', 'raise', 250), a(P2, 'preflop', 'fold'), a(P3, 'preflop', 'fold')],
    });
    expect(has(analyzeHand(sbFold), 'SB_OVERFOLD', P2)).toBe(true);
  });
});

describe('pipeline discipline', () => {
  it('kill switch drops a tag', () => {
    const record = rec({
      participants: THREE(), winners: [P3],
      actions: () => [...blinds(P2, P3),
        a(P1, 'preflop', 'call', 100), a(P2, 'preflop', 'fold'), a(P3, 'preflop', 'check')],
    });
    expect(has(analyzeHand(record), 'OPEN_LIMP')).toBe(true);
    const killed = analyzeHand(record, { settings: { killSwitches: { OPEN_LIMP: false } } });
    expect(has(killed, 'OPEN_LIMP')).toBe(false);
    expect(has(killed, 'LIMPED_POT')).toBe(true); // others unaffected
  });

  it('one analyzer failing never blocks the others (isolate + log)', () => {
    const log = vi.fn();
    // Corrupt hole cards at an all-in-and-call make the equity analyzer
    // throw (CardGroup rejects them); hand-level descriptors still land.
    const record = rec({
      participants: [
        { playerId: P1, position: 'BTN', holeCards: ['XX', 'YY'], folded: false },
        { playerId: P2, position: 'BB', holeCards: ['ZZ', 'WW'], folded: false },
      ],
      board: ['Ah', 'Kh', '2c', '7d', '3s'], showdownReached: true, winners: [P1],
      actions: () => [...blinds(P1, P2),
        a(P1, 'preflop', 'raise', 10000, { allIn: true }),
        a(P2, 'preflop', 'call', 9900, { allIn: true })],
    });
    const tags = analyzeHand(record, { log });
    expect(has(tags, 'SINGLE_RAISED_POT')).toBe(true);          // survivor
    expect(has(tags, 'ALLIN_PREFLOP')).toBe(true);              // survivor
    expect(log).toHaveBeenCalledWith('player-descriptors', expect.anything());
  });

  it('reverted actions are invisible to analyzers', () => {
    const record = rec({
      participants: THREE(), winners: [P3], undoUsed: true,
      actions: () => [...blinds(P2, P3),
        a(P1, 'preflop', 'call', 100, { reverted: true }),  // undone limp
        a(P1, 'preflop', 'raise', 300),
        a(P2, 'preflop', 'fold'), a(P3, 'preflop', 'fold')],
    });
    const tags = analyzeHand(record);
    expect(has(tags, 'OPEN_LIMP')).toBe(false);
    expect(has(tags, 'SINGLE_RAISED_POT')).toBe(true);
  });
});

describe('equity vectors (docs/decisions/0008)', () => {
  it('canonical preflop, turn and river vectors hold', () => {
    const [aa, kk] = headsUpEquity(['As', 'Ad'], ['Ks', 'Kd']);
    expect(aa).toBeGreaterThan(80); expect(aa).toBeLessThan(84.5);
    expect(kk).toBeGreaterThan(15.5); expect(kk).toBeLessThan(20);

    const [aks, qq] = headsUpEquity(['Ah', 'Kh'], ['Qs', 'Qd']);
    expect(aks).toBeGreaterThan(44); expect(aks).toBeLessThan(48);
    expect(qq).toBeGreaterThan(52); expect(qq).toBeLessThan(56);

    const [kkRiver, aaRiver] = headsUpEquity(
      ['Ks', 'Kd'], ['Ah', 'Ac'], ['As', '7s', '2h', '3d', '9c']
    );
    expect(kkRiver).toBe(0); expect(aaRiver).toBe(100);

    const [aaTurn] = headsUpEquity(['As', 'Ad'], ['Ks', 'Kd'], ['2c', '7s', 'Jh', '3d']);
    expect(aaTurn).toBeGreaterThan(93);
  });
});
