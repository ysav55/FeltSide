/**
 * Range-grid utilities for the 13×13 matrix (BUILT NEW — decision 0004;
 * old-repo extractions were reference only). Token-level only: the matrix
 * selects grid cells ("AKs", "77", "T9o"); the server's RangeParser is the
 * combo-level authority.
 */

export const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const IDX = Object.fromEntries(RANKS.map((r, i) => [r, i]));

/** Cell (row, col) → canonical token. Upper-right = suited, lower-left = offsuit. */
export function cellToken(row, col) {
  if (row === col) return `${RANKS[row]}${RANKS[col]}`;
  if (col > row) return `${RANKS[row]}${RANKS[col]}s`;
  return `${RANKS[col]}${RANKS[row]}o`;
}

const isRank = (r) => IDX[r] !== undefined;

function normalize(raw) {
  return raw.trim().toUpperCase().replace(/([SO])(?=$|\+|-)/g, (m) => m.toLowerCase());
}

/** Expand ONE grammar token into grid-cell tokens. */
function expandToken(token) {
  const out = [];
  const pairSpan = (hi, lo) => {
    for (let i = IDX[hi]; i <= IDX[lo]; i++) out.push(`${RANKS[i]}${RANKS[i]}`);
  };
  if (token.endsWith('+')) {
    const base = token.slice(0, -1);
    if (base.length === 2 && base[0] === base[1] && isRank(base[0])) {
      pairSpan('A', base[0]); // 66+ → AA..66
    } else if (base.length >= 2 && isRank(base[0]) && isRank(base[1])) {
      const qualifiers = base.length === 3 ? [base[2]] : ['s', 'o'];
      const hi = IDX[base[0]] < IDX[base[1]] ? base[0] : base[1];
      const lo = IDX[base[0]] < IDX[base[1]] ? base[1] : base[0];
      for (let i = IDX[lo]; i > IDX[hi]; i--) {
        for (const q of qualifiers) out.push(`${hi}${RANKS[i]}${q}`);
      }
    }
    return out;
  }
  if (token.includes('-')) {
    const [left, right] = token.split('-').map((t) => t.trim());
    if (left.length === 2 && left[0] === left[1] && right.length === 2 && right[0] === right[1]) {
      const hi = IDX[left[0]] < IDX[right[0]] ? left[0] : right[0];
      const lo = IDX[left[0]] < IDX[right[0]] ? right[0] : left[0];
      pairSpan(hi, lo);
    } else if (left.length === 3 && right.length === 3 && left[2] === right[2]) {
      const gap = IDX[left[1]] - IDX[left[0]];
      if (gap === IDX[right[1]] - IDX[right[0]] && gap > 0) {
        const from = Math.min(IDX[left[0]], IDX[right[0]]);
        const to = Math.max(IDX[left[0]], IDX[right[0]]);
        for (let i = from; i <= to; i++) {
          out.push(`${RANKS[i]}${RANKS[i + gap]}${left[2]}`);
        }
      }
    }
    return out;
  }
  if (token.length === 2 && token[0] === token[1] && isRank(token[0])) { out.push(token); return out; }
  if (token.length >= 2 && isRank(token[0]) && isRank(token[1]) && token[0] !== token[1]) {
    const hi = IDX[token[0]] < IDX[token[1]] ? token[0] : token[1];
    const lo = IDX[token[0]] < IDX[token[1]] ? token[1] : token[0];
    if (token.length === 3 && ['s', 'o'].includes(token[2])) out.push(`${hi}${lo}${token[2]}`);
    else if (token.length === 2) out.push(`${hi}${lo}s`, `${hi}${lo}o`);
  }
  return out;
}

/** Range string → Set of grid-cell tokens. Unknown tokens are skipped. */
export function expandRange(rangeStr) {
  const set = new Set();
  if (!rangeStr || typeof rangeStr !== 'string') return set;
  for (const raw of rangeStr.split(',')) {
    const token = normalize(raw);
    if (!token) continue;
    for (const cell of expandToken(token)) set.add(cell);
  }
  return set;
}

/** Set of cell tokens → canonical comma-joined range string (grid order). */
export function rangeFromTokens(tokens) {
  const ordered = [];
  for (let row = 0; row < 13; row++) {
    for (let col = 0; col < 13; col++) {
      const t = cellToken(row, col);
      if (tokens.has(t)) ordered.push(t);
    }
  }
  return ordered.join(',');
}
