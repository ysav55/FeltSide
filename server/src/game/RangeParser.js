/**
 * RangeParser — poker hand-range notation (graduated from legacy/ per
 * PRD §9: new rule-based suite in test/game/rangeParser.test.js).
 *
 * Supported syntax (comma-separated, any combination):
 *   AA          — specific pair (6 combos)
 *   AA-TT       — pair range descending
 *   AKs / AKo   — suited (4) / offsuit (12)
 *   AK          — both (16)
 *   AQs+ / AJo+ / AQ+ — that holding and all higher kickers vs the anchor
 *   66+         — pairs from 66 up
 *   JTs-87s     — suited connector range (same gap, descending)
 *
 * Graduation fixes vs legacy:
 *   - cards are emitted in ENGINE format (rank uppercase + suit lowercase,
 *     e.g. "As") — legacy emitted all-uppercase, which no other module uses;
 *   - pickFromRange accepts an injectable rng (determinism in tests);
 *   - rangeContains() added for chart membership (TAXONOMY §4).
 *
 * Not supported (v1, per DEALING §7): weighted ranges, percentage notation.
 */

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['h', 'd', 'c', 's'];
export const RANK_INDEX = Object.fromEntries(RANKS.map((r, i) => [r, i]));

const isRank = (r) => RANKS.includes(r);

function pairCombos(rank) {
  const cards = SUITS.map((s) => `${rank}${s}`);
  const combos = [];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) combos.push([cards[i], cards[j]]);
  }
  return combos;
}

function suitedCombos(r1, r2) {
  return SUITS.map((s) => [`${r1}${s}`, `${r2}${s}`]);
}

function offsuitCombos(r1, r2) {
  const combos = [];
  for (const s1 of SUITS) {
    for (const s2 of SUITS) {
      if (s1 !== s2) combos.push([`${r1}${s1}`, `${r2}${s2}`]);
    }
  }
  return combos;
}

function parseSingleToken(token) {
  if (token.length === 2 && token[0] === token[1] && isRank(token[0])) {
    return pairCombos(token[0]);
  }
  if (token.length === 3 && isRank(token[0]) && isRank(token[1])) {
    const [r1, r2, qualifier] = token;
    if (r1 === r2) return [];
    const [hi, lo] = RANK_INDEX[r1] > RANK_INDEX[r2] ? [r1, r2] : [r2, r1];
    if (qualifier === 's') return suitedCombos(hi, lo);
    if (qualifier === 'o') return offsuitCombos(hi, lo);
    return [];
  }
  if (token.length === 2 && isRank(token[0]) && isRank(token[1]) && token[0] !== token[1]) {
    const [hi, lo] = RANK_INDEX[token[0]] > RANK_INDEX[token[1]]
      ? [token[0], token[1]] : [token[1], token[0]];
    return [...suitedCombos(hi, lo), ...offsuitCombos(hi, lo)];
  }
  return [];
}

function parsePairRange(hiRank, loRank) {
  const hi = RANK_INDEX[hiRank];
  const lo = RANK_INDEX[loRank];
  if (hi < lo) return [];
  const result = [];
  for (let i = lo; i <= hi; i++) result.push(...pairCombos(RANKS[i]));
  return result;
}

function parsePlusToken(token) {
  if (token.length === 2 && token[0] === token[1] && isRank(token[0])) {
    const lo = RANK_INDEX[token[0]];
    const result = [];
    for (let i = lo; i < RANKS.length; i++) result.push(...pairCombos(RANKS[i]));
    return result;
  }
  if (token.length === 3 && isRank(token[0]) && isRank(token[1])) {
    const [r1, r2, qualifier] = token;
    if (!['s', 'o'].includes(qualifier)) return [];
    const hi = RANK_INDEX[r1] > RANK_INDEX[r2] ? r1 : r2;
    const lo = RANK_INDEX[r1] > RANK_INDEX[r2] ? r2 : r1;
    const result = [];
    for (let i = RANK_INDEX[lo]; i < RANK_INDEX[hi]; i++) {
      const kicker = RANKS[i];
      if (qualifier === 's') result.push(...suitedCombos(hi, kicker));
      else result.push(...offsuitCombos(hi, kicker));
    }
    return result;
  }
  if (token.length === 2 && isRank(token[0]) && isRank(token[1]) && token[0] !== token[1]) {
    const hi = RANK_INDEX[token[0]] > RANK_INDEX[token[1]] ? token[0] : token[1];
    const lo = RANK_INDEX[token[0]] > RANK_INDEX[token[1]] ? token[1] : token[0];
    const result = [];
    for (let i = RANK_INDEX[lo]; i < RANK_INDEX[hi]; i++) {
      const kicker = RANKS[i];
      result.push(...suitedCombos(hi, kicker), ...offsuitCombos(hi, kicker));
    }
    return result;
  }
  return [];
}

function parseSuitedConnectorRange(hiToken, loToken) {
  if (hiToken.length !== 3 || loToken.length !== 3) return [];
  if (hiToken[2] !== 's' || loToken[2] !== 's') return [];
  const hiTop = RANK_INDEX[hiToken[0]];
  const hiBot = RANK_INDEX[hiToken[1]];
  const loTop = RANK_INDEX[loToken[0]];
  const loBot = RANK_INDEX[loToken[1]];
  const gap = hiTop - hiBot;
  if (gap !== loTop - loBot || gap <= 0) return [];
  if (hiTop < loTop) return [];
  const result = [];
  for (let top = loTop; top <= hiTop; top++) {
    const bot = top - gap;
    if (bot < 0) continue;
    result.push(...suitedCombos(RANKS[top], RANKS[bot]));
  }
  return result;
}

/** Normalize user input to canonical case: ranks upper, s/o qualifiers lower. */
function normalizeToken(raw) {
  return raw
    .trim()
    .toUpperCase()
    // Lowercase a suited/offsuit qualifier wherever it appears: token end,
    // before a '+' (AQs+), or before a '-' (JTs-87s halves rejoin later).
    .replace(/([SO])(?=$|\+|-)/g, (m) => m.toLowerCase());
}

/** parseRange(rangeStr) → Array of [card, card] pairs in engine format. */
export function parseRange(rangeStr) {
  if (!rangeStr || typeof rangeStr !== 'string') return [];
  const tokens = rangeStr.split(',').map((t) => t.trim()).filter(Boolean);
  const seen = new Set();
  const result = [];

  for (const raw of tokens) {
    const token = normalizeToken(raw);
    let combos = [];
    if (token.endsWith('+')) {
      combos = parsePlusToken(token.slice(0, -1));
    } else if (token.includes('-')) {
      const [left, right] = token.split('-').map((t) => normalizeToken(t));
      if (
        left.length === 2 && right.length === 2 &&
        left[0] === left[1] && right[0] === right[1] &&
        isRank(left[0]) && isRank(right[0])
      ) {
        const hiRank = RANK_INDEX[left[0]] > RANK_INDEX[right[0]] ? left[0] : right[0];
        const loRank = RANK_INDEX[left[0]] > RANK_INDEX[right[0]] ? right[0] : left[0];
        combos = parsePairRange(hiRank, loRank);
      } else if (left.length === 3 && right.length === 3) {
        const hiT = RANK_INDEX[left[0]] > RANK_INDEX[right[0]] ? left : right;
        const loT = RANK_INDEX[left[0]] > RANK_INDEX[right[0]] ? right : left;
        combos = parseSuitedConnectorRange(hiT, loT);
      }
    } else {
      combos = parseSingleToken(token);
    }

    for (const pair of combos) {
      const key = [...pair].sort().join(',');
      if (!seen.has(key)) {
        seen.add(key);
        result.push(pair);
      }
    }
  }
  return result;
}

/** validateRange(rangeStr) → { valid, error?, comboCount? } */
export function validateRange(rangeStr) {
  if (!rangeStr || typeof rangeStr !== 'string' || rangeStr.trim() === '') {
    return { valid: false, error: 'Range string is empty' };
  }
  const combos = parseRange(rangeStr);
  if (combos.length === 0) {
    return { valid: false, error: `No valid combos found in range "${rangeStr}"` };
  }
  return { valid: true, comboCount: combos.length };
}

/**
 * pickFromRange(rangeStr, usedCards, rng) → [card, card] | null
 * Uniform draw (DEALING §2.3) excluding used cards; injectable rng.
 */
export function pickFromRange(rangeStr, usedCards = new Set(), rng = Math.random) {
  const combos = parseRange(rangeStr);
  if (combos.length === 0) return null;
  const shuffled = [...combos];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  for (const [c1, c2] of shuffled) {
    if (!usedCards.has(c1) && !usedCards.has(c2)) return [c1, c2];
  }
  return null;
}

/** rangeContains(rangeStr, [c1, c2]) → is this exact holding in the range? */
export function rangeContains(rangeStr, holding) {
  if (!Array.isArray(holding) || holding.length !== 2) return false;
  const key = [...holding].sort().join(',');
  return parseRange(rangeStr).some((pair) => [...pair].sort().join(',') === key);
}

export function countCombos(rangeStr) {
  return parseRange(rangeStr).length;
}
