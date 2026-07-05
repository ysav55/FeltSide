/**
 * rangeParser.js — client-side mirror of server/game/RangeParser.js
 * ES module version (same logic, same outputs).
 */

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['h', 'd', 'c', 's'];
const RANK_INDEX = Object.fromEntries(RANKS.map((r, i) => [r, i]));

function isRank(r) { return RANKS.includes(r); }

function pairCombos(rank) {
  const cards = SUITS.map(s => `${rank}${s}`);
  const combos = [];
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++)
      combos.push([cards[i], cards[j]]);
  return combos;
}

function suitedCombos(r1, r2) {
  return SUITS.map(s => [`${r1}${s}`, `${r2}${s}`]);
}

function offsuitCombos(r1, r2) {
  const combos = [];
  for (const s1 of SUITS)
    for (const s2 of SUITS)
      if (s1 !== s2) combos.push([`${r1}${s1}`, `${r2}${s2}`]);
  return combos;
}

function parseSingleToken(token) {
  token = token.trim().toUpperCase();
  if (token.length === 2 && token[0] === token[1] && isRank(token[0]))
    return pairCombos(token[0]);
  if (token.length === 3 && isRank(token[0]) && isRank(token[1])) {
    const r1 = token[0], r2 = token[1], q = token[2];
    if (r1 === r2) return [];
    const [hi, lo] = RANK_INDEX[r1] > RANK_INDEX[r2] ? [r1, r2] : [r2, r1];
    if (q === 'S') return suitedCombos(hi, lo);
    if (q === 'O') return offsuitCombos(hi, lo);
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
  const hi = RANK_INDEX[hiRank], lo = RANK_INDEX[loRank];
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
    const r1 = token[0], r2 = token[1], q = token[2];
    if (!['S', 'O'].includes(q)) return [];
    const hi = RANK_INDEX[r1] > RANK_INDEX[r2] ? r1 : r2;
    const lo = RANK_INDEX[r1] > RANK_INDEX[r2] ? r2 : r1;
    const result = [];
    for (let i = RANK_INDEX[lo]; i < RANK_INDEX[hi]; i++) {
      const kicker = RANKS[i];
      if (q === 'S') result.push(...suitedCombos(hi, kicker));
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
  if (hiToken[2] !== 'S' || loToken[2] !== 'S') return [];
  const hiTop = RANK_INDEX[hiToken[0]], hiBot = RANK_INDEX[hiToken[1]];
  const loTop = RANK_INDEX[loToken[0]];
  const hiGap = hiTop - hiBot;
  const loGap = RANK_INDEX[loToken[0]] - RANK_INDEX[loToken[1]];
  if (hiGap !== loGap || hiGap <= 0 || hiTop < loTop) return [];
  const result = [];
  for (let top = loTop; top <= hiTop; top++) {
    const bot = top - hiGap;
    if (bot < 0) continue;
    result.push(...suitedCombos(RANKS[top], RANKS[bot]));
  }
  return result;
}

export function parseRange(rangeStr) {
  if (!rangeStr || typeof rangeStr !== 'string') return [];
  const tokens = rangeStr.toUpperCase().split(',').map(t => t.trim()).filter(Boolean);
  const seen = new Set();
  const result = [];
  for (const token of tokens) {
    let combos = [];
    if (token.endsWith('+')) {
      combos = parsePlusToken(token.slice(0, -1));
    } else if (token.includes('-')) {
      const [left, right] = token.split('-');
      const l = left.trim(), r = right.trim();
      if (l.length === 2 && r.length === 2 && l[0] === l[1] && r[0] === r[1]
          && isRank(l[0]) && isRank(r[0])) {
        const hiRank = RANK_INDEX[l[0]] > RANK_INDEX[r[0]] ? l[0] : r[0];
        const loRank = RANK_INDEX[l[0]] > RANK_INDEX[r[0]] ? r[0] : l[0];
        combos = parsePairRange(hiRank, loRank);
      } else if (l.length === 3 && r.length === 3) {
        const hiT = RANK_INDEX[l[0]] > RANK_INDEX[r[0]] ? l : r;
        const loT = RANK_INDEX[l[0]] > RANK_INDEX[r[0]] ? r : l;
        combos = parseSuitedConnectorRange(hiT, loT);
      }
    } else {
      combos = parseSingleToken(token);
    }
    for (const pair of combos) {
      const key = [...pair].sort().join(',');
      if (!seen.has(key)) { seen.add(key); result.push(pair); }
    }
  }
  return result;
}

export function validateRange(rangeStr) {
  if (!rangeStr || typeof rangeStr !== 'string' || rangeStr.trim() === '')
    return { valid: false, error: 'Range string is empty' };
  const combos = parseRange(rangeStr);
  if (combos.length === 0)
    return { valid: false, error: `No valid combos in "${rangeStr}"` };
  return { valid: true, comboCount: combos.length };
}

export function countCombos(rangeStr) {
  return parseRange(rangeStr).length;
}
