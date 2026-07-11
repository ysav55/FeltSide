import { useCallback, useMemo, useRef, useState } from 'react';
import { RANKS, cellToken, expandRange, rangeFromTokens } from '../utils/ranges.js';

/**
 * The 13×13 range matrix — BUILT NEW (decision 0004). Drag-select paints;
 * the first cell decides add/remove mode. Value is a range string; edits
 * emit a canonical token list (server RangeParser accepts it verbatim).
 * Shared by the dealing panel's range-draw and the chart editors (M5 §4).
 */
export default function RangeMatrix({ value, onChange, disabled = false }) {
  const tokens = useMemo(() => expandRange(value ?? ''), [value]);
  const [drag, setDrag] = useState(null); // 'add' | 'remove' | null
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;

  const paint = useCallback((token, mode) => {
    const next = new Set(tokensRef.current);
    if (mode === 'add') next.add(token); else next.delete(token);
    onChange?.(rangeFromTokens(next));
  }, [onChange]);

  const start = (token) => {
    if (disabled) return;
    const mode = tokens.has(token) ? 'remove' : 'add';
    setDrag(mode);
    paint(token, mode);
  };
  const enter = (token) => { if (drag) paint(token, drag); };

  return (
    <div
      className="inline-grid select-none touch-none"
      style={{ gridTemplateColumns: 'repeat(13, 1.9rem)' }}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setDrag(null)}
      role="grid"
      aria-label="range matrix"
    >
      {RANKS.map((_, row) => RANKS.map((__, col) => {
        const token = cellToken(row, col);
        const selected = tokens.has(token);
        const kind = row === col ? 'pair' : col > row ? 'suited' : 'offsuit';
        return (
          <button
            key={token}
            type="button"
            role="gridcell"
            aria-label={token}
            aria-pressed={selected}
            disabled={disabled}
            onPointerDown={(e) => { e.preventDefault(); start(token); }}
            onPointerEnter={() => enter(token)}
            className={[
              'h-7 text-[10px] font-mono border border-slate-800 leading-none',
              selected
                ? 'bg-emerald-600 text-white'
                : kind === 'pair' ? 'bg-slate-800 text-slate-300'
                  : kind === 'suited' ? 'bg-slate-900 text-slate-400'
                    : 'bg-slate-950 text-slate-500',
              disabled ? 'opacity-50' : 'hover:border-emerald-500',
            ].join(' ')}
          >
            {token}
          </button>
        );
      }))}
    </div>
  );
}
