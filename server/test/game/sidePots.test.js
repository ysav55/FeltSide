import { describe, it, expect } from 'vitest';
import { buildSidePots } from '../../src/game/SidePotCalculator.js';

// Written from poker rules: each all-in contribution level caps a pot;
// folded chips count toward pot amounts but folded players win nothing.

const p = (id, contributed, { active = true, allIn = false } = {}) => ({
  id, total_contributed: contributed, is_active: active, is_all_in: allIn,
});

describe('buildSidePots', () => {
  it('no all-ins → single main pot, signalled as []', () => {
    expect(buildSidePots([p('a', 100), p('b', 100), p('c', 100)])).toEqual([]);
  });

  it('classic 3-way all-in ladder: 100 / 300 / 500', () => {
    const pots = buildSidePots([
      p('short', 100, { allIn: true }),
      p('mid', 300, { allIn: true }),
      p('big', 500),
    ]);
    expect(pots).toHaveLength(3);
    // Main pot: 3 × 100
    expect(pots[0]).toEqual({ amount: 300, eligiblePlayerIds: ['short', 'mid', 'big'] });
    // First side pot: 2 × 200
    expect(pots[1]).toEqual({ amount: 400, eligiblePlayerIds: ['mid', 'big'] });
    // Second side pot: big's unmatched 200
    expect(pots[2]).toEqual({ amount: 200, eligiblePlayerIds: ['big'] });
  });

  it("folded player's chips swell the pots but never make them eligible", () => {
    const pots = buildSidePots([
      p('short', 100, { allIn: true }),
      p('folder', 250, { active: false }),
      p('big', 400),
    ]);
    // Main pot: 100×3 = 300; eligible short+big only
    expect(pots[0]).toEqual({ amount: 300, eligiblePlayerIds: ['short', 'big'] });
    // Next level 400: folder adds 150 more, big adds 300 → 450; only big eligible
    expect(pots[1]).toEqual({ amount: 450, eligiblePlayerIds: ['big'] });
  });

  it('equal all-ins collapse into one level (heads-up all-in, no split needed)', () => {
    const pots = buildSidePots([
      p('a', 200, { allIn: true }),
      p('b', 200, { allIn: true }),
    ]);
    // Single level, everyone eligible → effectively the main pot → []
    expect(pots).toEqual([]);
  });

  it('all-in short stack vs two callers', () => {
    const pots = buildSidePots([
      p('short', 50, { allIn: true }),
      p('a', 200),
      p('b', 200),
    ]);
    expect(pots[0]).toEqual({ amount: 150, eligiblePlayerIds: ['short', 'a', 'b'] });
    expect(pots[1]).toEqual({ amount: 300, eligiblePlayerIds: ['a', 'b'] });
  });

  it('fewer than two contributors → no pots', () => {
    expect(buildSidePots([p('a', 100, { allIn: true }), p('b', 0)])).toEqual([]);
    expect(buildSidePots(null)).toEqual([]);
  });
});
