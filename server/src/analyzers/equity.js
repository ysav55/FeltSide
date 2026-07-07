import { CardGroup, OddsCalculator } from 'poker-odds-calculator';

/**
 * Equity adapter over poker-odds-calculator (docs/decisions/0008 — the
 * command decision: a maintained library, never hand-rolled). Postflop is
 * exact enumeration; preflop is the library's 100k-iteration Monte Carlo
 * (±~0.5pp — ample against the 60/40 ALLIN_* thresholds).
 *
 * Returns each side's equity as win% + half the tie% (0–100).
 */
export function headsUpEquity(hole1, hole2, board = []) {
  const groups = [CardGroup.fromString(hole1.join('')), CardGroup.fromString(hole2.join(''))];
  const boardGroup = board.length ? CardGroup.fromString(board.join('')) : null;
  const result = OddsCalculator.calculate(groups, boardGroup);
  return result.equities.map((e) => e.getEquity() + e.getTiePercentage() / 2);
}
