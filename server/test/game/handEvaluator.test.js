import { describe, it, expect } from 'vitest';
import { evaluate, compareHands, HAND_RANKS } from '../../src/game/HandEvaluator.js';

// Written from poker rules (PRD §9: never from old behavior).
const beats = (a, b) => expect(compareHands(a, b)).toBeGreaterThan(0);
const ties = (a, b) => expect(compareHands(a, b)).toBe(0);

describe('hand category detection (7 cards, best 5 chosen)', () => {
  it.each([
    [['As', 'Ks'], ['Qs', 'Js', 'Ts', '2h', '3d'], 'ROYAL_FLUSH'],
    [['9s', '8s'], ['7s', '6s', '5s', 'Ah', 'Ad'], 'STRAIGHT_FLUSH'],
    [['Ah', 'Ad'], ['As', 'Ac', 'Kd', '2c', '3h'], 'FOUR_OF_A_KIND'],
    [['Kh', 'Kd'], ['Ks', 'Qc', 'Qd', '2c', '3h'], 'FULL_HOUSE'],
    [['Ah', 'Th'], ['7h', '4h', '2h', 'Ks', 'Kd'], 'FLUSH'],
    [['9c', '8d'], ['7h', '6s', '5d', 'Kh', 'Kd'], 'STRAIGHT'],
    [['7h', '7d'], ['7s', 'Kc', 'Qd', '2c', '3h'], 'THREE_OF_A_KIND'],
    [['Ah', 'Kd'], ['As', 'Kc', 'Qd', '2c', '3h'], 'TWO_PAIR'],
    [['Ah', 'Ad'], ['Ks', 'Qc', 'Jd', '2c', '3h'], 'ONE_PAIR'],
    [['Ah', 'Qd'], ['Ts', '8c', '6d', '4c', '2h'], 'HIGH_CARD'],
  ])('%j + %j → %s', (hole, board, expected) => {
    expect(evaluate(hole, board).rankName).toBe(expected);
  });

  it('picks the best five from seven (flush over straight when both exist)', () => {
    // 5h6h7h8h on board + 9d in hole makes a straight, but Ah2h in hole... use:
    const result = evaluate(['Ah', '9d'], ['5h', '6h', '7h', '8h', 'Kd']);
    // Straight 5-9 exists, but so does the A-high flush (Ah 5h 6h 7h 8h)
    expect(result.rankName).toBe('FLUSH');
  });
});

describe('the wheel (A-2-3-4-5)', () => {
  it('is a straight with the FIVE high, not ace high', () => {
    const wheel = evaluate(['Ah', '2d'], ['3s', '4c', '5d', 'Kh', 'Qd']);
    expect(wheel.rankName).toBe('STRAIGHT');
    const sixHigh = evaluate(['2h', '6d'], ['3s', '4c', '5d', 'Kh', 'Qd']);
    beats(sixHigh, wheel); // 6-high straight beats the wheel
  });

  it('two wheels tie', () => {
    const a = evaluate(['Ah', '2d'], ['3s', '4c', '5d', 'Kh', 'Qd']);
    const b = evaluate(['Ac', '2h'], ['3s', '4c', '5d', 'Kh', 'Qd']);
    ties(a, b);
  });

  it('steel wheel (A-5 straight flush) beats quads', () => {
    const steel = evaluate(['Ah', '2h'], ['3h', '4h', '5h', 'Kd', 'Kc']);
    expect(steel.rankName).toBe('STRAIGHT_FLUSH');
    const quads = evaluate(['Kh', 'Ks'], ['Kd', 'Kc', '5h', '3h', '2h']);
    beats(steel, quads);
  });
});

describe('category ordering', () => {
  it('every category beats the one below it', () => {
    const ladder = [
      evaluate(['Ah', 'Qd'], ['Ts', '8c', '6d', '4c', '2h']), // high card
      evaluate(['Ah', 'Ad'], ['Ks', 'Qc', 'Jd', '2c', '3h']), // pair
      evaluate(['Ah', 'Kd'], ['As', 'Kc', 'Qd', '2c', '3h']), // two pair
      evaluate(['7h', '7d'], ['7s', 'Kc', 'Qd', '2c', '3h']), // trips
      evaluate(['9c', '8d'], ['7h', '6s', '5d', 'Kh', 'Qd']), // straight
      evaluate(['Ah', 'Th'], ['7h', '4h', '2h', 'Ks', 'Qd']), // flush
      evaluate(['Kh', 'Kd'], ['Ks', 'Qc', 'Qd', '2c', '3h']), // full house
      evaluate(['Ah', 'Ad'], ['As', 'Ac', 'Kd', '2c', '3h']), // quads
      evaluate(['9s', '8s'], ['7s', '6s', '5s', 'Ah', 'Kd']), // straight flush
      evaluate(['As', 'Ks'], ['Qs', 'Js', 'Ts', '2h', '3d']), // royal
    ];
    for (let i = 1; i < ladder.length; i++) beats(ladder[i], ladder[i - 1]);
  });
});

describe('tiebreaks within a category', () => {
  it('pair: higher pair wins; equal pair goes to kickers', () => {
    const aces = evaluate(['Ah', 'Ad'], ['9s', '7c', '5d', '3c', '2h']);
    const kings = evaluate(['Kh', 'Kd'], ['9s', '7c', '5d', '3c', '2h']);
    beats(aces, kings);
    const akKicker = evaluate(['9h', 'Ad'], ['9s', 'Kc', '5d', '3c', '2h']);
    const aqKicker = evaluate(['9h', 'Qd'], ['9s', 'Kc', '5d', '3c', '2h']);
    beats(akKicker, aqKicker);
  });

  it('two pair: top pair decides, then second pair, then kicker', () => {
    const acesUp = evaluate(['Ah', '2d'], ['As', '2c', 'Qd', '7c', '5h']);
    const kingsUp = evaluate(['Kh', 'Qd'], ['Ks', 'Qc', 'Jd', '7c', '5h']);
    beats(acesUp, kingsUp);
    const acesOverKings = evaluate(['Ah', 'Kd'], ['As', 'Kc', '4d', '7c', '5h']);
    const acesOverQueens = evaluate(['Ah', 'Qd'], ['As', 'Qc', '4d', '7c', '5h']);
    beats(acesOverKings, acesOverQueens);
  });

  it('full house: trips rank first, then the pair', () => {
    const kingsFullOfTwos = evaluate(['Kh', 'Kd'], ['Ks', '2c', '2d', '7c', '5h']);
    const queensFullOfAces = evaluate(['Qh', 'Qd'], ['Qs', 'Ac', 'Ad', '7c', '5h']);
    beats(kingsFullOfTwos, queensFullOfAces);
    const kingsFullOfAces = evaluate(['Kh', 'Kd'], ['Ks', 'Ac', 'Ad', '7c', '5h']);
    beats(kingsFullOfAces, kingsFullOfTwos); // ISS-26 territory: pair breaks trips tie
  });

  it('quads: kicker breaks equal quads (board quads)', () => {
    const aceKicker = evaluate(['Ah', '3d'], ['7s', '7c', '7d', '7h', '5c']);
    const kingKicker = evaluate(['Kh', '3d'], ['7s', '7c', '7d', '7h', '5c']);
    beats(aceKicker, kingKicker);
  });

  it('flush: compared card by card from the top', () => {
    const aHigh = evaluate(['Ah', '2h'], ['9h', '7h', '4h', 'Ks', 'Qd']);
    const kHigh = evaluate(['Kh', '3h'], ['9h', '7h', '4h', 'As', 'Qd']);
    beats(aHigh, kHigh);
  });

  it('board plays: identical best-five split', () => {
    const board = ['As', 'Ks', 'Qs', 'Js', 'Ts']; // royal on the board
    ties(evaluate(['2h', '3d'], board), evaluate(['7c', '8h'], board));
  });
});
