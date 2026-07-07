import { evaluate, HAND_RANKS } from '../game/HandEvaluator.js';
import {
  liveActions, voluntary, street, tag, holeCardsOf, unfoldedIds,
} from './helpers.js';

/** TAXONOMY §3 — absolute-rule mistakes (player_id + action_seq). */
export function analyzeAbsoluteMistakes(record, { settings }) {
  const tags = [];
  const actions = liveActions(record);
  const preflop = voluntary(street(actions, 'preflop'));

  // ── OPEN_LIMP / OVERLIMP / COLD_CALL_3BET ────────────────────────────
  let raiseCount = 0;
  let limpers = 0;
  const invested = new Set(); // voluntary money in the pot before this action
  const blindIds = new Set(
    record.participants
      .filter((p) => ['SB', 'BB'].includes(p.position))
      .map((p) => p.playerId)
  );
  for (const a of preflop) {
    if (a.action === 'call') {
      if (raiseCount === 0) {
        tags.push(tag(limpers === 0 ? 'OPEN_LIMP' : 'OVERLIMP', 'mistake', a.playerId, a.seq));
        limpers += 1;
      } else if (raiseCount === 2 && !invested.has(a.playerId) && !blindIds.has(a.playerId)) {
        // Calls a 3-bet with no prior money invested in the pot.
        tags.push(tag('COLD_CALL_3BET', 'mistake', a.playerId, a.seq));
      }
    }
    if (a.action === 'raise') raiseCount += 1;
    if (['call', 'raise'].includes(a.action)) invested.add(a.playerId);
  }

  // ── MISSED_RIVER_VALUE: river check-back holding two pair or better ──
  if (record.board.length === 5) {
    const river = street(actions, 'river');
    const riverHadBet = river.some((a) => ['bet', 'raise'].includes(a.action));
    if (river.length > 0 && !riverHadBet) {
      const checks = river.filter((a) => a.action === 'check');
      const lastCheck = checks[checks.length - 1];
      const inPositionOnly = settings.thresholds.missedRiverValueInPositionOnly ?? true;
      const floor = HAND_RANKS[settings.thresholds.missedRiverValueFloor ?? 'TWO_PAIR']
        ?? HAND_RANKS.TWO_PAIR;
      const candidates = inPositionOnly && lastCheck ? [lastCheck] : checks;
      const live = new Set(unfoldedIds(record));
      for (const check of candidates) {
        if (!live.has(check.playerId)) continue;
        const hole = holeCardsOf(record, check.playerId);
        if (!hole) continue;
        if (evaluate(hole, record.board).rank >= floor) {
          tags.push(tag('MISSED_RIVER_VALUE', 'mistake', check.playerId, check.seq));
        }
      }
    }
  }

  return tags;
}
