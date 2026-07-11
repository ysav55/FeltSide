import { describe, it, expect } from 'vitest';
import {
  parseRange, validateRange, pickFromRange, rangeContains, countCombos,
} from '../../src/game/RangeParser.js';

// Graduation suite (PRD §9): new rule-based tests against the documented
// grammar — never against old behavior. Also pins the graduation fixes:
// engine card format + injectable rng + rangeContains.

describe('RangeParser — grammar', () => {
  it('combo counts per token form', () => {
    expect(countCombos('AA')).toBe(6);
    expect(countCombos('AKs')).toBe(4);
    expect(countCombos('AKo')).toBe(12);
    expect(countCombos('AK')).toBe(16);
    expect(countCombos('66+')).toBe(9 * 6);      // 66..AA
    expect(countCombos('AQs+')).toBe(8);         // AQs, AKs
    expect(countCombos('AJo+')).toBe(36);        // AJo, AQo, AKo
    expect(countCombos('AA-TT')).toBe(5 * 6);
    expect(countCombos('JTs-87s')).toBe(4 * 4);  // JTs T9s 98s 87s
    expect(countCombos('AA,AKs,AA')).toBe(10);   // dedup
  });

  it('emits ENGINE card format: rank uppercase + suit lowercase', () => {
    for (const [c1, c2] of parseRange('AKs,77')) {
      expect(c1).toMatch(/^[2-9TJQKA][hdcs]$/);
      expect(c2).toMatch(/^[2-9TJQKA][hdcs]$/);
    }
  });

  it('is input-case insensitive', () => {
    expect(countCombos('aks')).toBe(4);
    expect(countCombos('aqS+')).toBe(8);
    expect(countCombos('jts-87S')).toBe(16);
  });

  it('validateRange flags garbage and empties', () => {
    expect(validateRange('').valid).toBe(false);
    expect(validateRange('XX').valid).toBe(false);
    expect(validateRange('AA').valid).toBe(true);
    expect(validateRange('AA').comboCount).toBe(6);
  });
});

describe('RangeParser — draws & membership', () => {
  it('pickFromRange excludes used cards and is rng-deterministic', () => {
    const used = new Set(['Ah', 'Ad']);
    const pick = pickFromRange('AA', used, () => 0);
    // Only AcAs avoids the used cards.
    expect([...pick].sort()).toEqual(['Ac', 'As']);
    // Fully blocked range → null.
    expect(pickFromRange('AA', new Set(['Ah', 'Ad', 'Ac', 'As']))).toBeNull();
  });

  it('rangeContains matches exact holdings, order-insensitive', () => {
    expect(rangeContains('AQs+', ['Ah', 'Qh'])).toBe(true);
    expect(rangeContains('AQs+', ['Qh', 'Ah'])).toBe(true);
    expect(rangeContains('AQs+', ['Ah', 'Qd'])).toBe(false); // offsuit
    expect(rangeContains('77+', ['7h', '7d'])).toBe(true);
    expect(rangeContains('77+', ['6h', '6d'])).toBe(false);
  });
});
