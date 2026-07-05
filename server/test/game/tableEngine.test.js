import { describe, it, expect } from 'vitest';
import { TableEngine } from '../../src/game/TableEngine.js';
import { scriptedCardSourceFactory } from '../../src/game/cardSource.js';

// Engine-level tests from poker rules: blinds, turn order, betting
// legality, uncalled-bet refunds, all-in runouts, chip conservation.

function build({ script = [{}], tableSize = 6, sb = 50, bb = 100 } = {}) {
  const events = [];
  const engine = new TableEngine({
    config: { smallBlind: sb, bigBlind: bb, tableSize },
    cardSourceFactory: scriptedCardSourceFactory(script),
    listener: (e) => events.push(e),
  });
  return { engine, events };
}

const chipSum = (engine) =>
  engine.occupiedSeats().reduce((sum, s) => sum + s.stack + s.contributed, 0);

describe('blinds and turn order', () => {
  it('3-handed: SB/BB posted, button acts first preflop, SB first postflop', async () => {
    const { engine } = build();
    engine.seatPlayer({ playerId: 'a', name: 'A', stack: 10000 });
    engine.seatPlayer({ playerId: 'b', name: 'B', stack: 10000 });
    engine.seatPlayer({ playerId: 'c', name: 'C', stack: 10000 });
    await engine.startHand();

    expect(engine.button).toBe(0);
    expect(engine.findSeat('b').contributed).toBe(50);   // SB
    expect(engine.findSeat('c').contributed).toBe(100);  // BB
    expect(engine.toAct).toBe(0); // button = first preflop actor 3-handed

    await engine.act('a', { type: 'call' });
    await engine.act('b', { type: 'call' });
    await engine.act('c', { type: 'check' }); // BB option closes the round
    expect(engine.phase).toBe('flop');
    expect(engine.board).toHaveLength(3);
    expect(engine.toAct).toBe(1); // SB first postflop
  });

  it('heads-up: button posts SB and acts first preflop, last postflop', async () => {
    const { engine } = build();
    engine.seatPlayer({ playerId: 'a', name: 'A', stack: 10000 });
    engine.seatPlayer({ playerId: 'b', name: 'B', stack: 10000 });
    await engine.startHand();

    expect(engine.button).toBe(0);
    expect(engine.findSeat('a').contributed).toBe(50);  // BTN = SB heads-up
    expect(engine.findSeat('b').contributed).toBe(100);
    expect(engine.toAct).toBe(0); // BTN first preflop

    await engine.act('a', { type: 'call' });
    await engine.act('b', { type: 'check' });
    expect(engine.phase).toBe('flop');
    expect(engine.toAct).toBe(1); // BB first postflop, BTN in position
  });

  it('button rotates to the next eligible seat each hand', async () => {
    const { engine } = build();
    engine.seatPlayer({ playerId: 'a', name: 'A', stack: 10000 });
    engine.seatPlayer({ playerId: 'b', name: 'B', stack: 10000 });
    engine.seatPlayer({ playerId: 'c', name: 'C', stack: 10000 });
    await engine.startHand();
    expect(engine.button).toBe(0);
    // Fold it out to end quickly (a, then b folds → c wins)
    await engine.act('a', { type: 'fold' });
    await engine.act('b', { type: 'fold' });
    expect(engine.phase).toBe('hand_complete');
    await engine.startHand();
    expect(engine.button).toBe(1);
  });
});

describe('betting rules', () => {
  it('BB gets the option and can raise a limped pot', async () => {
    const { engine } = build();
    engine.seatPlayer({ playerId: 'a', name: 'A', stack: 10000 });
    engine.seatPlayer({ playerId: 'b', name: 'B', stack: 10000 });
    engine.seatPlayer({ playerId: 'c', name: 'C', stack: 10000 });
    await engine.startHand();
    await engine.act('a', { type: 'call' });
    await engine.act('b', { type: 'call' });
    expect(engine.phase).toBe('preflop'); // BB still to act
    await engine.act('c', { type: 'raise', amount: 400 });
    expect(engine.currentBet).toBe(400);
    expect(engine.toAct).toBe(0); // action reopened to the limpers
  });

  it('min-raise enforced; short all-in raise does not reopen action', async () => {
    const { engine } = build({ tableSize: 6 });
    engine.seatPlayer({ playerId: 'a', name: 'A', stack: 10000 });
    engine.seatPlayer({ playerId: 'b', name: 'B', stack: 10000 });
    engine.seatPlayer({ playerId: 'c', name: 'C', stack: 550 }); // short stack
    await engine.startHand();

    // a (BTN) raises to 400 → min re-raise is to 700
    await engine.act('a', { type: 'raise', amount: 400 });
    await expect(engine.act('b', { type: 'raise', amount: 500 }))
      .rejects.toThrow('invalid_raise_size');
    await engine.act('b', { type: 'call' }); // SB calls 350 more
    // c (BB) shoves 550 total — a SHORT raise (< 700)
    await engine.act('c', { type: 'raise', amount: 550 });
    // a already acted and faces only the short raise: raise not reopened
    expect(engine.legalActions('a').raise).toBeNull();
    await engine.act('a', { type: 'call' });
    expect(engine.legalActions('b').raise).toBeNull();
    await engine.act('b', { type: 'call' });
    // c is all-in; a and b continue on the flop
    expect(engine.phase).toBe('flop');
  });

  it('cannot check facing a bet; cannot act out of turn', async () => {
    const { engine } = build();
    engine.seatPlayer({ playerId: 'a', name: 'A', stack: 10000 });
    engine.seatPlayer({ playerId: 'b', name: 'B', stack: 10000 });
    await engine.startHand();
    await expect(engine.act('b', { type: 'check' })).rejects.toThrow('not_your_turn');
    await expect(engine.act('a', { type: 'check' })).rejects.toThrow('cannot_check');
  });
});

describe('hand endings', () => {
  it('win by fold refunds the uncalled portion of a bet', async () => {
    const { engine } = build();
    engine.seatPlayer({ playerId: 'a', name: 'A', stack: 10000 });
    engine.seatPlayer({ playerId: 'b', name: 'B', stack: 10000 });
    await engine.startHand(); // a BTN/SB 50, b BB 100
    await engine.act('a', { type: 'raise', amount: 1000 });
    await engine.act('b', { type: 'fold' });
    // a wins b's 100; a's uncalled 900 comes back
    expect(engine.findSeat('a').stack).toBe(10100);
    expect(engine.findSeat('b').stack).toBe(9900);
    expect(chipSum(engine)).toBe(20000);
  });

  it('all-in runout deals every remaining street and shows down', async () => {
    const script = [{
      holeCards: { a: ['Ah', 'Ad'], b: ['Kh', 'Kd'] },
      board: ['2c', '7s', 'Jh', '3d', '9c'],
    }];
    const { engine, events } = build({ script });
    engine.seatPlayer({ playerId: 'a', name: 'A', stack: 5000 });
    engine.seatPlayer({ playerId: 'b', name: 'B', stack: 5000 });
    await engine.startHand();
    await engine.act('a', { type: 'raise', amount: 5000 }); // shove
    await engine.act('b', { type: 'call' });
    expect(engine.phase).toBe('hand_complete');
    expect(engine.board).toHaveLength(5);
    expect(engine.findSeat('a').stack).toBe(10000); // aces hold
    expect(engine.findSeat('b').stack).toBe(0);
    const record = events.find((e) => e.type === 'hand_complete').record;
    expect(record.showdownReached).toBe(true);
    expect(record.pot).toBe(10000);
  });

  it('side pots: short stack triple-up while big stacks contest the side pot', async () => {
    const script = [{
      holeCards: { a: ['Ah', 'Ad'], b: ['Kh', 'Kd'], c: ['Qh', 'Qd'] },
      board: ['2c', '7s', 'Jh', '3d', '9c'],
    }];
    const { engine } = build({ script });
    engine.seatPlayer({ playerId: 'a', name: 'A', stack: 1000 }); // BTN, short, aces
    engine.seatPlayer({ playerId: 'b', name: 'B', stack: 8000 });
    engine.seatPlayer({ playerId: 'c', name: 'C', stack: 8000 });
    await engine.startHand();
    await engine.act('a', { type: 'raise', amount: 1000 }); // short shove
    await engine.act('b', { type: 'raise', amount: 3000 });
    await engine.act('c', { type: 'call' });
    // b and c still have chips behind — they check down the side pot.
    for (let i = 0; i < 3; i++) {
      await engine.act('b', { type: 'check' });
      await engine.act('c', { type: 'check' });
    }
    expect(engine.phase).toBe('hand_complete');
    // Main pot 3000 → a; side pot 4000 → b (kings beat queens)
    expect(engine.findSeat('a').stack).toBe(3000);
    expect(engine.findSeat('b').stack).toBe(5000 + 4000);
    expect(engine.findSeat('c').stack).toBe(5000);
    expect(chipSum(engine)).toBe(17000);
  });

  it('a mid-hand leaver forfeits committed chips but the pot stays whole', async () => {
    const { engine } = build();
    engine.seatPlayer({ playerId: 'a', name: 'A', stack: 10000 });
    engine.seatPlayer({ playerId: 'b', name: 'B', stack: 10000 });
    engine.seatPlayer({ playerId: 'c', name: 'C', stack: 10000 });
    await engine.startHand();
    await engine.act('a', { type: 'raise', amount: 500 });
    await engine.act('b', { type: 'call' });
    await engine.act('c', { type: 'call' });
    // flop: b leaves mid-hand (out of turn)
    expect(engine.phase).toBe('flop');
    await engine.unseat('b');
    expect(engine.findSeat('b')).not.toBeNull(); // seat held till hand end
    expect(engine.toAct).toBe(2); // c (SB seat 2? no — SB=b seat1) — c is next live
    await engine.act('c', { type: 'bet', amount: 800 });
    await engine.act('a', { type: 'fold' });
    expect(engine.phase).toBe('hand_complete');
    expect(engine.findSeat('b')).toBeNull(); // released after the hand
    // c won a's 500 + b's 500 (leaver's chips stayed in the pot)
    expect(engine.occupiedSeats().find((s) => s.playerId === 'c').stack).toBe(11000);
  });
});
