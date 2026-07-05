import { describe, it, expect } from 'vitest';
import { resolve } from '../../src/game/ShowdownResolver.js';

// Written from poker rules: best five-card hand wins each pot it is
// eligible for; split pots divide evenly, odd chip to the seat closest
// clockwise from the small blind.

function player(id, seat, holeCards, {
  contributed = 0, active = true, allIn = false, sb = false, name = id,
} = {}) {
  return {
    id, name, seat, hole_cards: holeCards,
    total_contributed: contributed, is_active: active, is_all_in: allIn,
    is_small_blind: sb,
  };
}

describe('single pot showdown', () => {
  const board = ['Ah', 'Kd', '7s', '4c', '2h'];

  it('best hand takes the whole pot', () => {
    const winner = player('w', 0, ['As', 'Ac'], { contributed: 100 }); // trip aces
    const loser = player('l', 1, ['Kh', 'Qc'], { contributed: 100, sb: true }); // pair kings
    const { stackDeltas, winner: wid, pot } = resolve([winner, loser], [winner, loser], board, 200);
    expect(wid).toBe('w');
    expect(stackDeltas.get('w')).toBe(200);
    expect(stackDeltas.get('l')).toBeUndefined();
    expect(pot).toBe(0);
  });

  it('split pot divides evenly', () => {
    const a = player('a', 0, ['Ts', '9c'], { contributed: 100 });
    const b = player('b', 1, ['Td', '9h'], { contributed: 100, sb: true });
    const { stackDeltas, showdown_result } = resolve([a, b], [a, b], board, 200);
    expect(stackDeltas.get('a')).toBe(100);
    expect(stackDeltas.get('b')).toBe(100);
    expect(showdown_result.splitPot).toBe(true);
  });

  it('odd chip goes to the winner closest clockwise from the SB', () => {
    const a = player('a', 0, ['Ts', '9c'], { contributed: 100 });
    const b = player('b', 1, ['Td', '9h'], { contributed: 101, sb: true });
    const c = player('c', 2, ['3s', '3d'], { contributed: 0, active: false });
    const { stackDeltas } = resolve([a, b], [a, b, c], board, 201);
    // b IS the SB (distance 0), a is distance 2 → b gets the odd chip
    expect(stackDeltas.get('b')).toBe(101);
    expect(stackDeltas.get('a')).toBe(100);
  });
});

describe('side pot showdown', () => {
  it('short stack wins only the main pot; side pot goes to next best', () => {
    const board = ['2h', '7d', 'Js', 'Qc', '3h'];
    const short = player('short', 0, ['Ah', 'Ad'], { contributed: 100, allIn: true }); // aces
    const mid = player('mid', 1, ['Kh', 'Kd'], { contributed: 300, sb: true });        // kings
    const big = player('big', 2, ['9h', '9d'], { contributed: 300 });                  // nines
    const { stackDeltas } = resolve([short, mid, big], [short, mid, big], board, 700);
    // Main pot 300 → short (aces). Side pot 400 → mid (kings beat nines).
    expect(stackDeltas.get('short')).toBe(300);
    expect(stackDeltas.get('mid')).toBe(400);
    expect(stackDeltas.get('big')).toBeUndefined();
  });

  it('all-in winner scoops when holding the best hand', () => {
    const board = ['2h', '7d', 'Js', 'Qc', '3h'];
    const short = player('short', 0, ['9h', '9d'], { contributed: 100, allIn: true });
    const a = player('a', 1, ['Ah', 'Ad'], { contributed: 250, sb: true });
    const b = player('b', 2, ['Kh', 'Kd'], { contributed: 250 });
    const { stackDeltas } = resolve([short, a, b], [short, a, b], board, 600);
    // Main 300 → a (aces beat nines and kings); side 300 → a again
    expect(stackDeltas.get('a')).toBe(600);
    expect(stackDeltas.get('short')).toBeUndefined();
  });

  it('folded chips are in the pot and awarded to the winner', () => {
    const board = ['2h', '7d', 'Js', 'Qc', '3h'];
    const w = player('w', 0, ['Ah', 'Ad'], { contributed: 200 });
    const l = player('l', 1, ['Kh', 'Kd'], { contributed: 200, sb: true });
    const folder = player('f', 2, ['Th', 'Td'], { contributed: 80, active: false });
    const { stackDeltas } = resolve([w, l], [w, l, folder], board, 480);
    expect(stackDeltas.get('w')).toBe(480);
  });
});
