import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import RangeMatrix from '../components/RangeMatrix.jsx';
import { expandRange, rangeFromTokens, cellToken } from '../utils/ranges.js';
import { parseCardText, resolveRanks } from '../utils/cardInput.js';

afterEach(cleanup);

describe('ranges util (matrix ⇄ range string)', () => {
  it('expands grammar tokens to grid cells', () => {
    expect([...expandRange('AA')]).toEqual(['AA']);
    expect(expandRange('66+').size).toBe(9);
    expect(expandRange('AQs+').has('AKs')).toBe(true);
    expect(expandRange('AQs+').has('AQs')).toBe(true);
    expect(expandRange('AQs+').has('AJs')).toBe(false);
    expect(expandRange('AK').size).toBe(2); // AKs + AKo cells
    expect(expandRange('JTs-87s').size).toBe(4);
    expect(expandRange('AA-TT').size).toBe(5);
  });

  it('round-trips a selection through the canonical string', () => {
    const tokens = new Set(['AA', 'KK', 'AKs', 'AKo', 'T9s']);
    const str = rangeFromTokens(tokens);
    expect(expandRange(str)).toEqual(tokens);
  });

  it('cell layout: diagonal pairs, upper-right suited, lower-left offsuit', () => {
    expect(cellToken(0, 0)).toBe('AA');
    expect(cellToken(0, 1)).toBe('AKs');
    expect(cellToken(1, 0)).toBe('AKo');
  });
});

describe('DEALING §2.1 type-ahead grammar', () => {
  it('parses exact cards, rank-only, partials and garbage', () => {
    expect(parseCardText('Ah')).toEqual({ kind: 'cards', cards: ['Ah', null] });
    expect(parseCardText('ahkd')).toEqual({ kind: 'cards', cards: ['Ah', 'Kd'] });
    expect(parseCardText('AK')).toEqual({ kind: 'ranks', ranks: 'AK', pair: false });
    expect(parseCardText('77')).toEqual({ kind: 'ranks', ranks: '77', pair: true });
    expect(parseCardText('A')).toEqual({ kind: 'partial' });
    expect(parseCardText('AhK')).toEqual({ kind: 'partial' });
    expect(parseCardText('')).toEqual({ kind: 'empty' });
    expect(parseCardText('xyz').kind).toBe('invalid');
    expect(parseCardText('AhAh').kind).toBe('invalid');
  });

  it('resolves rank-only entries by mode, avoiding taken cards', () => {
    const suited = resolveRanks('AK', 's', new Set(), () => 0);
    expect(suited[0][1]).toBe(suited[1][1]); // same suit
    const off = resolveRanks('AK', 'o', new Set(), () => 0);
    expect(off[0][1]).not.toBe(off[1][1]);
    // All four aces taken → no pair combo left.
    expect(resolveRanks('AA', 'r', new Set(['Ah', 'Ad', 'Ac', 'As']))).toBeNull();
  });
});

describe('RangeMatrix component', () => {
  it('renders 169 cells and toggles a cell on click', () => {
    let value = '';
    const { rerender } = render(
      <RangeMatrix value={value} onChange={(v) => { value = v; }} />
    );
    expect(screen.getAllByRole('gridcell')).toHaveLength(169);
    fireEvent.pointerDown(screen.getByRole('gridcell', { name: 'AKs' }));
    fireEvent.pointerUp(screen.getByRole('gridcell', { name: 'AKs' }));
    expect(value).toBe('AKs');
    rerender(<RangeMatrix value={value} onChange={(v) => { value = v; }} />);
    expect(screen.getByRole('gridcell', { name: 'AKs' }).getAttribute('aria-pressed')).toBe('true');
  });
});
