import { describe, it, expect } from 'vitest';
import { icmEquities, icmDeal } from '../../src/tournament/icm.js';

/**
 * Malmuth-Harville verification vectors (docs/decisions/0011).
 * The 5000/3000/2000 case is the standard textbook example; expected
 * values are the exact hand-derived Harville chain results.
 */
describe('ICM (TOURNAMENTS §7)', () => {
  it('matches the textbook 3-way vector (50/30/20 for 5000/3000/2000)', () => {
    const ev = icmEquities([5000, 3000, 2000], [50, 30, 20]);
    // P(A 2nd) = .3·5000/7000 + .2·5000/8000 = .3392857…, etc.
    expect(ev[0]).toBeCloseTo(38.392857, 5);
    expect(ev[1]).toBeCloseTo(32.75, 5);
    expect(ev[2]).toBeCloseTo(28.857143, 5);
    expect(ev.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 9);
  });

  it('matches the dominant-stack 2-payout vector (65/35 for 9000/500/500)', () => {
    const ev = icmEquities([9000, 500, 500], [65, 35]);
    expect(ev[0]).toBeCloseTo(61.815789, 5);
    expect(ev[1]).toBeCloseTo(19.092105, 5);
    expect(ev[2]).toBeCloseTo(19.092105, 5);
    expect(ev.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 9);
  });

  it('heads-up: EV is the blend of both payouts by win probability', () => {
    const ev = icmEquities([7500, 2500], [65, 35]);
    expect(ev[0]).toBeCloseTo(57.5, 9); // .75·65 + .25·35
    expect(ev[1]).toBeCloseTo(42.5, 9);
  });

  it('equal stacks → equal equity', () => {
    const ev = icmEquities([1000, 1000, 1000, 1000], [40, 30, 20, 10]);
    for (const e of ev) expect(e).toBeCloseTo(25, 9);
  });

  it('a single payout reduces to chip-proportional equity', () => {
    const ev = icmEquities([6000, 3000, 1000], [100]);
    expect(ev[0]).toBeCloseTo(60, 9);
    expect(ev[1]).toBeCloseTo(30, 9);
    expect(ev[2]).toBeCloseTo(10, 9);
  });

  it('zero stacks get zero equity; equity is monotone in stack', () => {
    const ev = icmEquities([4000, 0, 6000], [60, 40]);
    expect(ev[1]).toBe(0);
    expect(ev[2]).toBeGreaterThan(ev[0]);
    expect(ev[0] + ev[2]).toBeCloseTo(100, 9);
  });

  it('big stack equity is capped below its chip share (payout pressure)', () => {
    // 80% of chips is worth less than 80% of a multi-place pool.
    const ev = icmEquities([8000, 1000, 1000], [50, 30, 20]);
    expect(ev[0]).toBeLessThan(80 * 0.6); // far below chip-proportional
    expect(ev[0]).toBeLessThan(50 + 30);  // can never exceed 1st+2nd money
  });

  it('final table of 9 stays exact and fast', () => {
    const stacks = [9000, 8000, 7000, 6000, 5000, 4000, 3000, 2000, 1000];
    const payouts = [40, 25, 20, 15];
    const started = Date.now();
    const ev = icmEquities(stacks, payouts);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(ev.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
    for (let i = 1; i < ev.length; i++) expect(ev[i]).toBeLessThan(ev[i - 1]);
  });

  it('icmDeal floors to whole chips, remainder to the chip leader, exact sum', () => {
    const amounts = icmDeal([5000, 3000, 2000], [50_001, 30_000, 20_000]);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(100_001);
    expect(Math.max(...amounts)).toBe(amounts[0]); // leader holds the remainder
  });
});
