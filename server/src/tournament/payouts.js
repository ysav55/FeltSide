/**
 * Payouts (TOURNAMENTS §5) — closed bankroll economy, pure functions.
 * Prize pool = all buy-ins + re-entries + add-ons; paid automatically at
 * completion; rounding remainder to first place (standard practice).
 */

const STANDARD_TABLE = [
  { maxField: 5, split: [100] },
  { maxField: 9, split: [65, 35] },
  { maxField: 13, split: [50, 30, 20] },
  { maxField: 18, split: [40, 25, 20, 15] },
  { maxField: 27, split: [38, 24, 16, 12, 10] },
  { maxField: 54, split: [33, 21, 15, 12, 10, 9] },
];

/** The percentage split for a field size (standard table, or explicit). */
export function payoutSplit(fieldSize, payoutTable = 'standard') {
  if (Array.isArray(payoutTable)) return payoutTable;
  const row = STANDARD_TABLE.find((r) => fieldSize <= r.maxField) ??
    STANDARD_TABLE[STANDARD_TABLE.length - 1];
  return row.split;
}

/**
 * computePayouts(pool, fieldSize, playerCount, payoutTable) →
 *   [amount for 1st, 2nd, …] summing EXACTLY to pool (remainder → first).
 * Places never exceed the number of distinct players.
 */
export function computePayouts(pool, fieldSize, playerCount, payoutTable = 'standard') {
  const split = payoutSplit(fieldSize, payoutTable).slice(0, Math.max(1, playerCount));
  const amounts = split.map((pct) => Math.floor((pool * pct) / 100));
  const remainder = pool - amounts.reduce((n, a) => n + a, 0);
  amounts[0] += remainder; // rounding remainder to first (§5)
  return amounts;
}
