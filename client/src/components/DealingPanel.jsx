import { useMemo, useState } from 'react';
import RangeMatrix from './RangeMatrix.jsx';
import { parseCardText, resolveRanks, normalizeCardText } from '../utils/cardInput.js';
import { RANKS } from '../utils/ranges.js';

const SUITS = ['h', 'd', 'c', 's'];
const SUIT_GLYPH = { h: '♥', d: '♦', c: '♣', s: '♠' };
const STREET_SLOTS = { flop: [0, 1, 2], turn: [3], river: [4] };

/** Cards currently claimed anywhere in the panel (grid graying, §2.2/§1.3). */
function claimedCards(panel) {
  const set = new Set();
  for (const slot of Object.values(panel.slots ?? {})) {
    if (slot?.mode === 'cards') for (const c of slot.cards ?? []) if (c) set.add(c);
  }
  for (const c of panel.board ?? []) if (c) set.add(c);
  return set;
}

/**
 * One seat/board card entry with the §2.1 type-ahead grammar. Commits via
 * onCommit(cards[]|null); rank-only entries open the s/o/r resolution row.
 */
function SlotInput({ label, current, taken, onCommit, onFocusSlot, single = false }) {
  const [text, setText] = useState('');
  const [pendingRanks, setPendingRanks] = useState(null);
  const [error, setError] = useState(null);

  const commitCards = (cards) => {
    setError(null);
    setText('');
    setPendingRanks(null);
    onCommit(cards);
  };

  const handleKey = (e) => {
    if (e.key === 'Enter') {
      const parsed = parseCardText(text);
      if (parsed.kind === 'cards') return commitCards(parsed.cards);
      if (parsed.kind === 'ranks') {
        if (parsed.pair) { // '77' → random suits automatically
          const pick = resolveRanks(parsed.ranks, 'r', taken);
          return pick ? commitCards(pick) : setError('no combo available');
        }
        return setPendingRanks(parsed.ranks);
      }
      if (parsed.kind === 'empty') return commitCards(null); // back to RNG
      return setError(parsed.reason ?? 'invalid');
    }
    if (e.key === 'Backspace' && text === '') {
      commitCards(null); // Backspace on empty clears the slot back to RNG
    }
    // Suit resolution shortcut keys while the prompt is open.
    if (pendingRanks && ['s', 'o', 'r'].includes(e.key)) {
      e.preventDefault();
      const pick = resolveRanks(pendingRanks, e.key, taken);
      return pick ? commitCards(pick) : setError('no combo available');
    }
    return undefined;
  };

  return (
    <div className="flex items-center gap-1">
      <input
        aria-label={label}
        value={text}
        onFocus={onFocusSlot}
        onChange={(e) => { setError(null); setText(normalizeCardText(e.target.value)); }}
        onKeyDown={handleKey}
        placeholder={current ?? 'RNG'}
        className={`w-16 rounded bg-slate-800 border px-1.5 py-1 text-xs font-mono
          ${error ? 'border-rose-500' : current ? 'border-emerald-700 text-emerald-300' : 'border-slate-700'}`}
      />
      {pendingRanks && (
        <span className="flex gap-0.5 text-[10px]">
          {['s', 'o', 'r'].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                const pick = resolveRanks(pendingRanks, m, taken);
                if (pick) commitCards(pick); else setError('no combo available');
              }}
              className="rounded bg-slate-700 hover:bg-slate-600 px-1.5 py-0.5 uppercase"
              title={{ s: 'suited', o: 'offsuit', r: 'random' }[m]}
            >
              {m}
            </button>
          ))}
        </span>
      )}
      {error && <span className="text-rose-400 text-[10px]">{error}</span>}
    </div>
  );
}

/** Persistent 13×4 deck grid (§2.2) — click a focused slot, click a card. */
function DeckGrid({ claimed, onPick, disabled }) {
  return (
    <div className="inline-grid gap-px" style={{ gridTemplateColumns: 'repeat(13, 1.7rem)' }}>
      {SUITS.map((s) => RANKS.map((r) => {
        const card = `${r}${s}`;
        const gone = claimed.has(card);
        const red = s === 'h' || s === 'd';
        return (
          <button
            key={card}
            type="button"
            disabled={gone || disabled}
            onClick={() => onPick(card)}
            className={`h-6 text-[10px] font-mono border border-slate-800
              ${gone ? 'bg-slate-950 text-slate-700 line-through' : 'bg-slate-900 hover:border-emerald-500'}
              ${red ? 'text-rose-400' : 'text-slate-300'}`}
          >
            {r}{SUIT_GLYPH[s]}
          </button>
        );
      }))}
    </div>
  );
}

/**
 * The dealing panel (DEALING §2) — coach sidebar only; every payload here
 * arrives via the coach-gated socket channel, so nothing in it ever
 * reaches a player.
 */
export default function DealingPanel({ table, coach, send }) {
  const panel = coach.panel;
  const [focus, setFocus] = useState(null); // { kind:'seat', playerId, idx } | { kind:'board', idx }
  const [rangeFor, setRangeFor] = useState(null); // playerId with the matrix open
  const [scenarioName, setScenarioName] = useState('');
  const claimed = useMemo(() => claimedCards(panel), [panel]);

  const seats = (table.seats ?? []).filter(Boolean);
  const setHole = (playerId, slot) => send('panel:hole', { player_id: playerId, slot });
  const setBoard = (index, card) => send('panel:board', { index, card });

  const pickFromGrid = (card) => {
    if (!focus) return;
    if (focus.kind === 'board') return setBoard(focus.idx, card);
    const slot = panel.slots[focus.playerId];
    const cards = slot?.mode === 'cards' ? [...(slot.cards ?? [null, null])] : [null, null];
    cards[focus.idx] = card;
    return setHole(focus.playerId, { mode: 'cards', cards });
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3 flex flex-col gap-3 text-sm">
      <h3 className="text-xs uppercase tracking-wide text-slate-400">Dealing panel</h3>

      {coach.awaiting && (
        <div className="rounded-lg border border-amber-600 bg-amber-950/40 p-2 flex items-center gap-2">
          <span className="text-amber-200 text-xs">
            Waiting on the {coach.awaiting.street} — fill the slot(s) or release to RNG.
          </span>
          <button
            type="button"
            onClick={() => send('provide', {})}
            className="rounded bg-emerald-700 hover:bg-emerald-600 px-2 py-1 text-xs"
          >
            Deal it
          </button>
          <button
            type="button"
            onClick={() => send('rng-rest', {})}
            className="rounded bg-slate-700 hover:bg-slate-600 px-2 py-1 text-xs"
            title="One-key escape hatch: RNG the rest of this street"
          >
            RNG rest
          </button>
        </div>
      )}

      {/* Seat rows */}
      <div className="flex flex-col gap-1.5">
        {seats.map((seat) => {
          const slot = panel.slots[seat.playerId];
          const assigned = coach.assigned?.[seat.playerId];
          return (
            <div key={seat.playerId} className="flex items-center gap-2">
              <span className="w-20 truncate text-slate-300 text-xs">{seat.name}</span>
              {slot?.mode === 'range' ? (
                <>
                  <button
                    type="button"
                    onClick={() => setRangeFor(rangeFor === seat.playerId ? null : seat.playerId)}
                    className="rounded bg-indigo-900/70 border border-indigo-700 px-2 py-1 text-xs font-mono max-w-40 truncate"
                    title={slot.range}
                  >
                    range: {slot.range || '—'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setHole(seat.playerId, null)}
                    className="text-slate-500 hover:text-slate-300 text-xs"
                  >
                    ✕
                  </button>
                </>
              ) : (
                <>
                  {[0, 1].map((idx) => (
                    <SlotInput
                      key={idx}
                      label={`${seat.name} card ${idx + 1}`}
                      single
                      current={slot?.cards?.[idx] ?? null}
                      taken={claimed}
                      onFocusSlot={() => setFocus({ kind: 'seat', playerId: seat.playerId, idx })}
                      onCommit={(cards) => {
                        if (cards === null) {
                          const next = [...(slot?.cards ?? [null, null])];
                          next[idx] = null;
                          return setHole(seat.playerId, next.every((c) => !c) ? null : { mode: 'cards', cards: next });
                        }
                        if (cards[1]) return setHole(seat.playerId, { mode: 'cards', cards });
                        const next = slot?.mode === 'cards' ? [...(slot.cards ?? [null, null])] : [null, null];
                        next[idx] = cards[0];
                        return setHole(seat.playerId, { mode: 'cards', cards: next });
                      }}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={() => { setHole(seat.playerId, { mode: 'range', range: '' }); setRangeFor(seat.playerId); }}
                    className="rounded bg-slate-800 hover:bg-slate-700 px-1.5 py-1 text-[10px]"
                    title="Range-draw (§2.3)"
                  >
                    R
                  </button>
                </>
              )}
              {assigned && (
                <span className="text-emerald-400 font-mono text-xs ml-auto">
                  {assigned.join(' ')}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {rangeFor && panel.slots[rangeFor]?.mode === 'range' && (
        <div className="overflow-x-auto">
          <RangeMatrix
            value={panel.slots[rangeFor].range}
            onChange={(range) => setHole(rangeFor, { mode: 'range', range })}
          />
        </div>
      )}

      {/* Board row + street policy */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="w-20 text-slate-400 text-xs">Board</span>
        {[0, 1, 2, 3, 4].map((idx) => (
          <SlotInput
            key={idx}
            label={`board ${idx + 1}`}
            single
            current={panel.board[idx]}
            taken={claimed}
            onFocusSlot={() => setFocus({ kind: 'board', idx })}
            onCommit={(cards) => setBoard(idx, cards === null ? null : cards[0])}
          />
        ))}
      </div>
      <div className="flex items-center gap-3 text-xs">
        {Object.keys(STREET_SLOTS).map((street) => (
          <label key={street} className="flex items-center gap-1 text-slate-400">
            {street}
            <select
              value={panel.streetPolicy[street]}
              onChange={(e) => send('panel:policy', { street, policy: e.target.value })}
              className="rounded bg-slate-800 border border-slate-700 px-1 py-0.5"
            >
              <option value="auto">auto</option>
              <option value="manual">manual</option>
              <option value="rng">rng</option>
            </select>
          </label>
        ))}
      </div>

      {/* Deck grid */}
      <div className="overflow-x-auto">
        <DeckGrid claimed={claimed} onPick={pickFromGrid} disabled={!focus} />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => send('deal', {})}
          className="rounded-md bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-sm font-medium"
        >
          Deal
        </button>
        <button
          type="button"
          onClick={() => send('redeal', {})}
          className="rounded-md bg-emerald-900 hover:bg-emerald-800 px-3 py-1.5 text-sm"
          title="Exact cards repeat; range slots re-draw (§4)"
        >
          Re-deal
        </button>
        <input
          value={scenarioName}
          onChange={(e) => setScenarioName(e.target.value)}
          placeholder="Scenario name"
          className="w-32 rounded bg-slate-800 border border-slate-700 px-2 py-1 text-xs"
        />
        <button
          type="button"
          onClick={() => {
            if (!scenarioName.trim()) return;
            send('save-scenario', { name: scenarioName.trim() });
            setScenarioName('');
          }}
          className="rounded-md bg-slate-700 hover:bg-slate-600 px-3 py-1.5 text-sm"
        >
          Save as scenario
        </button>
        {coach.drill && (
          <button
            type="button"
            onClick={() => send('next-drill', {})}
            className="rounded-md bg-indigo-800 hover:bg-indigo-700 px-3 py-1.5 text-sm"
          >
            Next drill ({coach.drill.index + 1}/{coach.drill.count} · {coach.drill.name})
          </button>
        )}
      </div>
    </div>
  );
}
