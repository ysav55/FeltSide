/**
 * DEALING §2.1 type-ahead grammar — pure, unit-tested.
 *
 *   'Ah'    → one card;  'AhKd' → both slots
 *   'AK'    → rank-only: needs suit resolution (s / o / r or exact suits)
 *   '77'    → pair rank-only: random suits automatically
 *   ''      → RNG slot
 */

const RANK = /[2-9TJQKA]/;
const SUIT = /[hdcs]/;
const ALL_SUITS = ['h', 'd', 'c', 's'];

/** Normalize raw keyboard text: ranks upper, suits lower. */
export function normalizeCardText(text) {
  return [...text].map((ch) => (
    /[hdcs]/i.test(ch) && !/[2-9TJQKA]/.test(ch) ? ch.toLowerCase() : ch.toUpperCase()
  )).join('');
}

/**
 * Parse the slot text. Returns one of:
 *   { kind: 'empty' }
 *   { kind: 'partial' }                       — keep typing
 *   { kind: 'cards', cards: [c1, c2|null] }   — concrete card(s)
 *   { kind: 'ranks', ranks: 'AK', pair: bool }— rank-only, awaiting s/o/r
 *   { kind: 'invalid', reason }
 */
export function parseCardText(raw) {
  const text = normalizeCardText(raw.trim());
  if (text === '') return { kind: 'empty' };

  // Exact cards: Ah / AhKd
  if (/^[2-9TJQKA][hdcs]$/.test(text)) return { kind: 'cards', cards: [text, null] };
  if (/^[2-9TJQKA][hdcs][2-9TJQKA][hdcs]$/.test(text)) {
    const cards = [text.slice(0, 2), text.slice(2)];
    if (cards[0] === cards[1]) return { kind: 'invalid', reason: 'duplicate card' };
    return { kind: 'cards', cards };
  }

  // Rank-only: AK / 77
  if (/^[2-9TJQKA]{2}$/.test(text)) {
    return { kind: 'ranks', ranks: text, pair: text[0] === text[1] };
  }

  // Prefixes of any valid form keep the input open.
  if (/^[2-9TJQKA]$/.test(text)) return { kind: 'partial' };
  if (/^[2-9TJQKA][hdcs][2-9TJQKA]$/.test(text)) return { kind: 'partial' };

  return { kind: 'invalid', reason: 'unrecognized input' };
}

/**
 * Resolve a rank-only entry ('AK' + s|o|r, '77' → r automatically) into two
 * concrete cards, avoiding `taken`. Returns null when nothing fits.
 */
export function resolveRanks(ranks, mode, taken = new Set(), rng = Math.random) {
  const [r1, r2] = ranks;
  const combos = [];
  if (r1 === r2) {
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) combos.push([r1 + ALL_SUITS[i], r2 + ALL_SUITS[j]]);
    }
  } else if (mode === 's') {
    for (const s of ALL_SUITS) combos.push([r1 + s, r2 + s]);
  } else if (mode === 'o') {
    for (const s1 of ALL_SUITS) {
      for (const s2 of ALL_SUITS) if (s1 !== s2) combos.push([r1 + s1, r2 + s2]);
    }
  } else { // 'r' — fully random
    for (const s1 of ALL_SUITS) {
      for (const s2 of ALL_SUITS) {
        if (r1 === r2 && s1 >= s2) continue;
        if (r1 + s1 !== r2 + s2) combos.push([r1 + s1, r2 + s2]);
      }
    }
  }
  const free = combos.filter(([a, b]) => !taken.has(a) && !taken.has(b));
  if (free.length === 0) return null;
  return free[Math.floor(rng() * free.length)];
}
