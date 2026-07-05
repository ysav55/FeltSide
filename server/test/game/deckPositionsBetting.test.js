import { describe, it, expect } from 'vitest';
import { createDeck, shuffleDeck, isValidCard, RANKS, SUITS } from '../../src/game/Deck.js';
import { buildPositionMap, getPosition, isInPosition, POSITION_NAMES } from '../../src/game/positions.js';
import { isBettingRoundOver, findNextActingPlayer } from '../../src/game/bettingRound.js';

describe('Deck', () => {
  it('creates the full 52-card deck, all unique, all valid', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
    expect(deck.every(isValidCard)).toBe(true);
    expect(RANKS).toHaveLength(13);
    expect(SUITS).toHaveLength(4);
  });

  it('shuffle is a permutation and does not mutate the input', () => {
    const deck = createDeck();
    const before = [...deck];
    const shuffled = shuffleDeck(deck);
    expect(deck).toEqual(before);
    expect([...shuffled].sort()).toEqual([...deck].sort());
  });

  it('shuffle is deterministic under an injected RNG', () => {
    const seededRng = (seed) => () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const a = shuffleDeck(createDeck(), seededRng(42));
    const b = shuffleDeck(createDeck(), seededRng(42));
    const c = shuffleDeck(createDeck(), seededRng(7));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('rejects malformed cards', () => {
    for (const bad of ['A', 'Axh', '1h', 'Ax', 'ha', '', null, 10]) {
      expect(isValidCard(bad)).toBe(false);
    }
  });
});

describe('positions', () => {
  const seat = (playerId, s) => ({ player_id: playerId, seat: s });

  it('heads-up: button is the small blind (labelled BTN) facing the BB', () => {
    const map = buildPositionMap([seat('a', 0), seat('b', 1)], 0);
    expect(map).toEqual({ a: 'BTN', b: 'BB' });
    expect(POSITION_NAMES[2]).toEqual(['BTN', 'BB']);
  });

  it('6-max order clockwise from the button', () => {
    const seated = [0, 1, 2, 3, 4, 5].map((s) => seat(`p${s}`, s));
    const map = buildPositionMap(seated, 2);
    expect(map).toEqual({
      p2: 'BTN', p3: 'SB', p4: 'BB', p5: 'UTG', p0: 'HJ', p1: 'CO',
    });
  });

  it('9-max includes UTG+1/UTG+2/MP', () => {
    const seated = Array.from({ length: 9 }, (_, s) => seat(`p${s}`, s));
    const map = buildPositionMap(seated, 0);
    expect(Object.values(map).sort()).toEqual(
      ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'MP', 'HJ', 'CO'].sort()
    );
    expect(getPosition(seated, 0, 'p0')).toBe('BTN');
    expect(getPosition(seated, 0, 'p3')).toBe('UTG');
  });

  it('gaps in seat numbers do not break the rotation', () => {
    const seated = [seat('a', 1), seat('b', 4), seat('c', 7)];
    expect(buildPositionMap(seated, 4)).toEqual({ b: 'BTN', c: 'SB', a: 'BB' });
  });

  it('isInPosition: button acts last postflop', () => {
    const seated = [seat('btn', 0), seat('sb', 1), seat('bb', 2)];
    expect(isInPosition(seated, 0, 'btn', 'sb')).toBe(true);
    expect(isInPosition(seated, 0, 'sb', 'btn')).toBe(false);
    expect(isInPosition(seated, 0, 'bb', 'sb')).toBe(false); // SB acts first
  });
});

describe('bettingRound helpers', () => {
  const actor = (id, { action = 'waiting', bet = 0, active = true, allIn = false } = {}) => ({
    id, action, total_bet_this_round: bet, is_active: active, is_all_in: allIn,
  });

  it('round is over when every active non-all-in player acted and matched', () => {
    const done = [
      actor('a', { action: 'call', bet: 100 }),
      actor('b', { action: 'raise', bet: 100 }),
    ];
    expect(isBettingRoundOver(done, 100)).toBe(true);
  });

  it('round continues while someone has not acted or has not matched', () => {
    expect(isBettingRoundOver(
      [actor('a', { action: 'waiting', bet: 0 }), actor('b', { action: 'raise', bet: 100 })], 100
    )).toBe(false);
    expect(isBettingRoundOver(
      [actor('a', { action: 'call', bet: 50 }), actor('b', { action: 'raise', bet: 100 })], 100
    )).toBe(false);
  });

  it('round is over when nobody can act (all-in showdown)', () => {
    expect(isBettingRoundOver([], 100)).toBe(true);
  });

  it('next actor skips folded and all-in players, wrapping the table', () => {
    const players = [
      actor('a'),
      actor('b', { active: false }),
      actor('c', { allIn: true }),
      actor('d'),
    ];
    expect(findNextActingPlayer(players, 'a')).toBe('d');
    expect(findNextActingPlayer(players, 'd')).toBe('a'); // wraps
  });

  it('returns null when no one can act', () => {
    const players = [actor('a', { allIn: true }), actor('b', { active: false })];
    expect(findNextActingPlayer(players, 'a')).toBeNull();
  });
});
