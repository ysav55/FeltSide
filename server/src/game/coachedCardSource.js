import { createDeck, shuffleDeck } from './Deck.js';
import { pickFromRange, validateRange } from './RangeParser.js';

/**
 * Coached card source (DEALING.md §§1–5) — the M4 implementation of the
 * deal seam. One source per hand, created from the live dealing panel:
 *
 *   panel = {
 *     slots: { [playerId]: { mode: 'cards', cards: ['Ah','Kd'|null] }
 *                        | { mode: 'range', range: 'AA,AQs+' } },
 *     board: [c|null, c|null, c|null, c|null, c|null],
 *     streetPolicy: { flop, turn, river }   // 'auto' | 'manual' | 'rng'
 *     fromScenario: boolean,
 *   }
 *
 * Hole slots freeze at deal time (re-deal repeats exact cards; range slots
 * re-draw). Board slots read LIVE — pre-staging and mid-hand choices both
 * land here. When a street is manual with unfilled slots the returned
 * promise stays pending (`awaiting_deal`) until the coach provides cards
 * or hits the RNG escape hatch.
 *
 * Card integrity is central (§1.3): one `used` set; duplicates rejected at
 * panel-set time by the runtime, re-checked here at draw time.
 */

const STREET_SLOTS = { flop: [0, 1, 2], turn: [3], river: [4] };

export function createCoachedSource(panel, { rng = Math.random, onAwaiting = () => {} } = {}) {
  const used = new Set();
  const deck = shuffleDeck(createDeck(), rng);
  let rngCursor = 0;
  // Origin bookkeeping (§1.4): per-slot specified / partial / untouched.
  const slotStates = [];
  let pending = null;

  /**
   * Cards the panel has spoken for (typed hole cards not yet dealt,
   * staged/pending board slots) are BLOCKED for RNG draws — pre-staging a
   * river card must survive every earlier random fill (§3 pre-staging).
   * Computed live so mid-hand staging is honored too.
   */
  const blocked = () => {
    const set = new Set();
    for (const slot of Object.values(panel.slots ?? {})) {
      if (slot?.mode === 'cards') for (const c of slot.cards ?? []) if (c) set.add(c);
    }
    for (const c of panel.board ?? []) if (c) set.add(c);
    return set;
  };

  const drawRng = () => {
    const reserved = blocked();
    while (rngCursor < deck.length) {
      const card = deck[rngCursor++];
      if (!used.has(card) && !reserved.has(card)) { used.add(card); return card; }
    }
    throw new Error('deck_exhausted');
  };

  const take = (card) => {
    if (used.has(card)) throw new Error(`duplicate_card:${card}`);
    used.add(card);
    return card;
  };

  function fillStreet(street, slots) {
    const out = [];
    let specified = 0;
    for (const idx of STREET_SLOTS[street]) {
      const card = slots[idx];
      if (card) { out.push(take(card)); specified += 1; }
      else out.push(drawRng());
    }
    slotStates.push(
      specified === STREET_SLOTS[street].length ? 'specified'
        : specified > 0 ? 'partial' : 'untouched'
    );
    return out;
  }

  return {
    async holeCards(seatKeys) {
      const out = {};
      for (const key of seatKeys) {
        const slot = panel.slots?.[key];
        if (slot?.mode === 'range' && slot.range) {
          if (!validateRange(slot.range).valid) throw new Error('invalid_range');
          const excluded = new Set([...used, ...blocked()]);
          const pick = pickFromRange(slot.range, excluded, rng);
          if (!pick) throw new Error('range_exhausted');
          pick.forEach((c) => used.add(c));
          out[key] = pick;
          slotStates.push('specified'); // range-draw counts as coach-specified
        } else if (slot?.mode === 'cards' && (slot.cards?.[0] || slot.cards?.[1])) {
          const c1 = slot.cards[0] ? take(slot.cards[0]) : drawRng();
          const c2 = slot.cards[1] ? take(slot.cards[1]) : drawRng();
          out[key] = [c1, c2];
          slotStates.push(slot.cards[0] && slot.cards[1] ? 'specified' : 'partial');
        } else {
          out[key] = [drawRng(), drawRng()];
          slotStates.push('untouched');
        }
      }
      return out;
    },

    async street(name, count) {
      const slots = panel.board ?? [];
      const indices = STREET_SLOTS[name];
      const filled = indices.filter((i) => slots[i]).length;
      const policy = panel.streetPolicy?.[name] ?? 'auto';

      if (policy === 'rng') {
        slotStates.push('untouched');
        return Array.from({ length: count }, drawRng);
      }
      if (filled === indices.length || (policy === 'auto' && filled === 0)) {
        return fillStreet(name, slots);
      }
      // Manual (or partially pre-staged) street with unfilled slots →
      // awaiting_deal (§3). Resolves via provideStreet / rngRest.
      return new Promise((resolve, reject) => {
        pending = { street: name, count, resolve, reject };
        onAwaiting({ street: name, indices, filled });
      });
    },

    /** Coach filled the pending slots (panel.board updated first). */
    provideStreet() {
      if (!pending) throw new Error('nothing_pending');
      const { street, resolve } = pending;
      const indices = STREET_SLOTS[street];
      const slots = panel.board ?? [];
      if (indices.some((i) => !slots[i])) throw new Error('slots_unfilled');
      pending = null;
      resolve(fillStreet(street, slots));
    },

    /** One-key escape hatch (§3): RNG the rest of the pending street. */
    rngRest() {
      if (!pending) throw new Error('nothing_pending');
      const { street, resolve } = pending;
      pending = null;
      resolve(fillStreet(street, panel.board ?? []));
    },

    /** Undo/rollback support: cards return to the pool. */
    release(cards) {
      for (const c of cards) used.delete(c);
    },

    get pending() { return pending; },

    /** DEALING §1.4 — computed, never declared. */
    origin() {
      if (panel.fromScenario) return 'scenario';
      if (slotStates.length === 0) return 'rng';
      if (slotStates.includes('partial')) return 'hybrid';
      const specified = slotStates.filter((s) => s === 'specified').length;
      if (specified === 0) return 'rng';
      if (specified === slotStates.length) return 'manual';
      return 'hybrid';
    },

    /** Panel-side duplicate guard (runtime calls before accepting input). */
    isUsed(card) { return used.has(card); },
  };
}
