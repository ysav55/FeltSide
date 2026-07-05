'use strict';

/**
 * RangeParser.js — Poker hand range notation parser
 *
 * Supported syntax (comma-separated, any combination):
 *   AA            — specific pair (6 combos)
 *   AA-TT         — pair range descending (all pairs AA down to TT)
 *   AKs           — suited only (4 combos)
 *   AKo           — offsuit only (12 combos)
 *   AK            — both suited + offsuit (16 combos)
 *   AQs+          — AQs and all higher suited (AQs, AKs)
 *   AJo+          — AJo and all higher offsuit (AJo, AQo, AKo)
 *   JTs-87s       — suited connector range descending (JTs, T9s, 98s, 87s)
 *
 * Not supported (v1): percentage notation, one-gappers via range, offsuit connector ranges
 */

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['h', 'd', 'c', 's'];

const RANK_INDEX = Object.fromEntries(RANKS.map((r, i) => [r, i]));

// ─────────────────────────────────────────────
//  Internal helpers
// ─────────────────────────────────────────────

/** Returns true if rank string is a single valid rank character */
function isRank(r) { return RANKS.includes(r); }

/**
 * Enumerate all 6 combos for a pair rank: [{r1, r2, suited: false}]
 * Returns combo strings like "AA", "KK"
 */
function pairCombos(rank) {
  // 6 combos: (h,d),(h,c),(h,s),(d,c),(d,s),(c,s)
  const cards = SUITS.map(s => `${rank}${s}`);
  const combos = [];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      combos.push([cards[i], cards[j]]);
    }
  }
  return combos;
}

/**
 * Enumerate all 4 suited combos for two different ranks
 */
function suitedCombos(r1, r2) {
  return SUITS.map(s => [`${r1}${s}`, `${r2}${s}`]);
}

/**
 * Enumerate all 12 offsuit combos for two different ranks
 */
function offsuitCombos(r1, r2) {
  const combos = [];
  for (const s1 of SUITS) {
    for (const s2 of SUITS) {
      if (s1 !== s2) combos.push([`${r1}${s1}`, `${r2}${s2}`]);
    }
  }
  return combos;
}

/**
 * Parse a single combo token (not a range, not a plus) into an array of card-pair arrays.
 * Token examples: "AA", "AKs", "AKo", "AK"
 */
function parseSingleToken(token) {
  token = token.trim().toUpperCase();

  // Pair: exactly 2 identical rank chars
  if (token.length === 2 && token[0] === token[1] && isRank(token[0])) {
    return pairCombos(token[0]);
  }

  // Suited or offsuit two-card: 3 chars, last is 'S' or 'O'
  if (token.length === 3 && isRank(token[0]) && isRank(token[1])) {
    const r1 = token[0], r2 = token[1], qualifier = token[2];
    if (r1 === r2) return []; // invalid pair with qualifier
    // Ensure higher rank first for consistency
    const [hi, lo] = RANK_INDEX[r1] > RANK_INDEX[r2] ? [r1, r2] : [r2, r1];
    if (qualifier === 'S') return suitedCombos(hi, lo);
    if (qualifier === 'O') return offsuitCombos(hi, lo);
    return [];
  }

  // Both suited + offsuit: 2 chars, different ranks
  if (token.length === 2 && isRank(token[0]) && isRank(token[1]) && token[0] !== token[1]) {
    const [hi, lo] = RANK_INDEX[token[0]] > RANK_INDEX[token[1]]
      ? [token[0], token[1]] : [token[1], token[0]];
    return [...suitedCombos(hi, lo), ...offsuitCombos(hi, lo)];
  }

  return []; // unrecognised
}

// ─────────────────────────────────────────────
//  Token parsers for each syntax form
// ─────────────────────────────────────────────

/**
 * Pair range: AA-TT → all pairs from hi to lo (inclusive, descending by rank index)
 */
function parsePairRange(hiRank, loRank) {
  const hi = RANK_INDEX[hiRank], lo = RANK_INDEX[loRank];
  if (hi < lo) return [];
  const result = [];
  for (let i = lo; i <= hi; i++) {
    result.push(...pairCombos(RANKS[i]));
  }
  return result;
}

/**
 * Plus notation: AQs+ → AQs, AKs (suited combos where second card ranks ≥ Q but < A)
 *               AJo+ → AJo, AQo, AKo
 *               66+  → 66, 77, 88, ..., AA (pairs ≥ 66)
 */
function parsePlusToken(token) {
  // Pair plus: "66+" → all pairs from 66 up to AA
  if (token.length === 2 && token[0] === token[1] && isRank(token[0])) {
    const lo = RANK_INDEX[token[0]];
    const result = [];
    for (let i = lo; i < RANKS.length; i++) {
      result.push(...pairCombos(RANKS[i]));
    }
    return result;
  }

  // Suited/offsuit plus: AQs+ → AQs, AKs
  if (token.length === 3 && isRank(token[0]) && isRank(token[1])) {
    const r1 = token[0], r2 = token[1], qualifier = token[2];
    if (!['S', 'O'].includes(qualifier)) return [];
    const hi = RANK_INDEX[r1] > RANK_INDEX[r2] ? r1 : r2; // anchor (higher rank, usually Ace)
    const lo = RANK_INDEX[r1] > RANK_INDEX[r2] ? r2 : r1; // variable rank
    const hiIdx = RANK_INDEX[hi];
    const loIdx = RANK_INDEX[lo];
    const result = [];
    // From loIdx up to hiIdx-1 (can't have same rank as anchor)
    for (let i = loIdx; i < hiIdx; i++) {
      const kicker = RANKS[i];
      if (qualifier === 'S') result.push(...suitedCombos(hi, kicker));
      else result.push(...offsuitCombos(hi, kicker));
    }
    return result;
  }

  // Both suited+offsuit plus: "AQ+" → AQs+AQo, AKs+AKo
  if (token.length === 2 && isRank(token[0]) && isRank(token[1]) && token[0] !== token[1]) {
    const hi = RANK_INDEX[token[0]] > RANK_INDEX[token[1]] ? token[0] : token[1];
    const lo = RANK_INDEX[token[0]] > RANK_INDEX[token[1]] ? token[1] : token[0];
    const hiIdx = RANK_INDEX[hi];
    const loIdx = RANK_INDEX[lo];
    const result = [];
    for (let i = loIdx; i < hiIdx; i++) {
      const kicker = RANKS[i];
      result.push(...suitedCombos(hi, kicker), ...offsuitCombos(hi, kicker));
    }
    return result;
  }

  return [];
}

/**
 * Suited connector range: JTs-87s → JTs, T9s, 98s, 87s
 * Format: XYs-ABs where X>Y and A>B (or equal gap), both suited, descending
 */
function parseSuitedConnectorRange(hiToken, loToken) {
  // e.g. hiToken="JTs", loToken="87s"
  if (hiToken.length !== 3 || loToken.length !== 3) return [];
  if (hiToken[2] !== 'S' || loToken[2] !== 'S') return [];

  const hiTop = RANK_INDEX[hiToken[0]];
  const hiBot = RANK_INDEX[hiToken[1]];
  const loTop = RANK_INDEX[loToken[0]];
  const loBot = RANK_INDEX[loToken[1]];

  // Validate both are "connectors" with same gap
  const hiGap = hiTop - hiBot;
  const loGap = loTop - loBot;
  if (hiGap !== loGap || hiGap <= 0) return [];
  if (hiTop < loTop) return []; // wrong order

  const result = [];
  // Step from hiTop down to loTop
  for (let top = loTop; top <= hiTop; top++) {
    const bot = top - hiGap;
    if (bot < 0) continue;
    result.push(...suitedCombos(RANKS[top], RANKS[bot]));
  }
  return result;
}

// ─────────────────────────────────────────────
//  Public API
// ─────────────────────────────────────────────

/**
 * parseRange(rangeStr) → Array of [card, card] pairs
 *
 * Each pair is a specific 2-card holding, e.g. ["As","Ks"].
 * Duplicates are removed. Empty array if nothing valid.
 */
function parseRange(rangeStr) {
  if (!rangeStr || typeof rangeStr !== 'string') return [];

  const tokens = rangeStr.toUpperCase().split(',').map(t => t.trim()).filter(Boolean);
  const seen = new Set();
  const result = [];

  for (const token of tokens) {
    let combos = [];

    // Plus notation: ends with +
    if (token.endsWith('+')) {
      combos = parsePlusToken(token.slice(0, -1));
    }
    // Range notation: contains - (e.g. AA-TT or JTs-87s)
    else if (token.includes('-')) {
      const [left, right] = token.split('-');
      const l = left.trim(), r = right.trim();

      // Pair range: AA-TT
      if (l.length === 2 && r.length === 2 && l[0] === l[1] && r[0] === r[1]
          && isRank(l[0]) && isRank(r[0])) {
        const hiRank = RANK_INDEX[l[0]] > RANK_INDEX[r[0]] ? l[0] : r[0];
        const loRank = RANK_INDEX[l[0]] > RANK_INDEX[r[0]] ? r[0] : l[0];
        combos = parsePairRange(hiRank, loRank);
      }
      // Suited connector range: JTs-87s
      else if (l.length === 3 && r.length === 3) {
        const hiT = RANK_INDEX[l[0]] > RANK_INDEX[r[0]] ? l : r;
        const loT = RANK_INDEX[l[0]] > RANK_INDEX[r[0]] ? r : l;
        combos = parseSuitedConnectorRange(hiT, loT);
      }
    }
    // Single token: AA, AKs, AKo, AK
    else {
      combos = parseSingleToken(token);
    }

    // Deduplicate by sorted card pair string
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

/**
 * validateRange(rangeStr) → { valid: boolean, error?: string, comboCount?: number }
 */
function validateRange(rangeStr) {
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
 * pickFromRange(rangeStr, usedCards) → [card, card] | null
 *
 * Parse the range, shuffle the resulting combos, return the first pair
 * where neither card is in usedCards. Returns null if no valid pair found.
 */
function pickFromRange(rangeStr, usedCards = new Set()) {
  const combos = parseRange(rangeStr);
  if (combos.length === 0) return null;

  // Fisher-Yates shuffle
  const shuffled = [...combos];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  for (const [c1, c2] of shuffled) {
    if (!usedCards.has(c1) && !usedCards.has(c2)) {
      return [c1, c2];
    }
  }
  return null; // all combos blocked by used cards
}

/**
 * countCombos(rangeStr) → number
 * Convenience: returns the number of distinct card pairs in the range.
 */
function countCombos(rangeStr) {
  return parseRange(rangeStr).length;
}

module.exports = { parseRange, validateRange, pickFromRange, countCombos, RANK_INDEX };
