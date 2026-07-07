/**
 * ICM — Malmuth-Harville, implemented fresh (M7 §7; the old repo never
 * contained an equity/ICM implementation — decisions/0004).
 *
 * P(i finishes 1st) = stack_i / total
 * P(i finishes k | j1..j(k-1) placed) = stack_i / (total − Σ placed stacks)
 *
 * $EV_i = Σ over paid places k of payout_k · P(i finishes k), where P(i, k)
 * sums the Harville chain over every ordering of the k−1 players above.
 * Field sizes here are small (final table ≤ 9, paid places ≤ 6), so direct
 * recursive enumeration with memoization over (subset placed, place) is
 * exact and fast. Verified against vectors in docs/decisions/0011.
 */

/**
 * icmEquities(stacks, payouts) → $EV per stack (same order as `stacks`).
 * `payouts` is the remaining prize money for these players, best place
 * first. Zero stacks get zero equity.
 */
export function icmEquities(stacks, payouts) {
  const n = stacks.length;
  const places = Math.min(payouts.length, n);
  const ev = new Array(n).fill(0);
  if (n === 0 || places === 0) return ev;
  const total = stacks.reduce((a, b) => a + b, 0);
  if (total === 0) return ev;

  // Walk every ordered placement chain up to `places` deep.
  // memo: probability mass reaching a given placed-subset is aggregated so
  // each (subset, depth) branch is expanded once.
  const memo = new Map(); // bitmask of placed players → accumulated probability
  memo.set(0, 1);
  for (let place = 0; place < places; place++) {
    const next = new Map();
    for (const [mask, prob] of memo) {
      let remaining = 0;
      for (let i = 0; i < n; i++) if (!(mask & (1 << i))) remaining += stacks[i];
      if (remaining === 0) continue;
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) continue;
        if (stacks[i] === 0) continue;
        const p = prob * (stacks[i] / remaining);
        ev[i] += p * payouts[place];
        const m2 = mask | (1 << i);
        next.set(m2, (next.get(m2) ?? 0) + p);
      }
    }
    memo.clear();
    for (const [k, v] of next) memo.set(k, v);
  }
  return ev;
}

/**
 * An ICM deal proposal: exact equities rounded down to whole chips, with the
 * rounding remainder to the current chip leader (mirrors §5's remainder-to-
 * first convention). Sums exactly to the remaining pool.
 */
export function icmDeal(stacks, payouts) {
  const pool = payouts.reduce((a, b) => a + b, 0);
  const ev = icmEquities(stacks, payouts);
  const amounts = ev.map((e) => Math.floor(e));
  const remainder = pool - amounts.reduce((a, b) => a + b, 0);
  const leader = stacks.indexOf(Math.max(...stacks));
  amounts[leader] += remainder;
  return amounts;
}
