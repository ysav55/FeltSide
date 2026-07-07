import { describe, it, expect } from 'vitest';
import { payoutSplit, computePayouts } from '../../src/tournament/payouts.js';

describe('payouts (TOURNAMENTS §5)', () => {
  it('uses the standard table by field size', () => {
    expect(payoutSplit(2)).toEqual([100]);
    expect(payoutSplit(5)).toEqual([100]);
    expect(payoutSplit(6)).toEqual([65, 35]);
    expect(payoutSplit(9)).toEqual([65, 35]);
    expect(payoutSplit(10)).toEqual([50, 30, 20]);
    expect(payoutSplit(13)).toEqual([50, 30, 20]);
    expect(payoutSplit(14)).toEqual([40, 25, 20, 15]);
    expect(payoutSplit(18)).toEqual([40, 25, 20, 15]);
    expect(payoutSplit(19)).toEqual([38, 24, 16, 12, 10]);
    expect(payoutSplit(27)).toEqual([38, 24, 16, 12, 10]);
    expect(payoutSplit(28)).toEqual([33, 21, 15, 12, 10, 9]);
    expect(payoutSplit(54)).toEqual([33, 21, 15, 12, 10, 9]);
    expect(payoutSplit(99)).toEqual([33, 21, 15, 12, 10, 9]); // clamp
  });

  it('accepts an explicit percentage table', () => {
    expect(payoutSplit(18, [50, 50])).toEqual([50, 50]);
  });

  it('sums exactly to the pool — remainder to first', () => {
    // 18 entrants × 10k = 180k, 4 places: 72k/45k/36k/27k, no remainder.
    expect(computePayouts(180_000, 18, 18)).toEqual([72_000, 45_000, 36_000, 27_000]);

    // Odd pool: 100_001 with a 65/35 split leaves 1 chip → first place.
    const odd = computePayouts(100_001, 8, 8);
    expect(odd).toEqual([65_001, 35_000]);
    expect(odd.reduce((a, b) => a + b, 0)).toBe(100_001);

    // Ugly pool never leaks a chip (closed economy).
    for (const pool of [999, 12_345, 77_777, 100_003]) {
      for (const field of [4, 7, 12, 16, 22, 33]) {
        const amounts = computePayouts(pool, field, field);
        expect(amounts.reduce((a, b) => a + b, 0)).toBe(pool);
      }
    }
  });

  it('never pays more places than distinct players', () => {
    // 10-entry field (re-entries) but only 2 distinct players.
    const amounts = computePayouts(100_000, 10, 2);
    expect(amounts).toHaveLength(2);
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(100_000);
  });
});
