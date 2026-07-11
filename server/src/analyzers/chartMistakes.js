import { rangeContains, validateRange } from '../game/RangeParser.js';
import {
  liveActions, voluntary, street, tag, holeCardsOf, positionOf,
} from './helpers.js';

/**
 * TAXONOMY §4 — chart-engine mistakes. Every relevant decision is compared
 * against the coach's reference charts. Fires on ALL hand origins (a chart
 * deviation in a drill is still evidence; stat exclusion is the CRM's job).
 */
export function analyzeChartMistakes(record, { settings }) {
  const tags = [];
  const actions = liveActions(record);
  const preflop = voluntary(street(actions, 'preflop'));
  const openCharts = settings.charts?.open ?? {};
  const defendCharts = settings.charts?.defend ?? {};

  const chart = (rangeStr) => rangeStr && validateRange(rangeStr).valid ? rangeStr : null;

  // ── First-in decisions vs the open chart ─────────────────────────────
  let entries = 0;   // voluntary entries so far (call or raise)
  let raiseCount = 0;
  let openerPos = null;
  for (const a of preflop) {
    const pos = positionOf(record, a.playerId);
    const hole = holeCardsOf(record, a.playerId);

    if (entries === 0 && hole && pos && pos !== 'BB') {
      const openChart = chart(openCharts[pos]);
      if (openChart) {
        if (a.action === 'raise' && !rangeContains(openChart, hole)) {
          tags.push(tag('OPEN_TOO_LOOSE', 'mistake', a.playerId, a.seq));
        }
        // The engine always knows hole cards — folds are judgeable.
        if (a.action === 'fold' && rangeContains(openChart, hole)) {
          tags.push(tag('OPEN_TOO_TIGHT', 'mistake', a.playerId, a.seq));
        }
      }
    }

    // Blind defense vs a SINGLE open (exactly one raise so far).
    if (raiseCount === 1 && hole && (pos === 'BB' || pos === 'SB')) {
      const defendChart = chart(defendCharts[pos]?.[openerPos]);
      if (defendChart) {
        const inChart = rangeContains(defendChart, hole);
        if (a.action === 'fold' && inChart) {
          tags.push(tag(pos === 'BB' ? 'BB_OVERFOLD' : 'SB_OVERFOLD', 'mistake', a.playerId, a.seq));
        }
        if (['call', 'raise'].includes(a.action) && !inChart) {
          tags.push(tag('BLIND_OVERDEFEND', 'mistake', a.playerId, a.seq));
        }
      }
    }

    if (['call', 'raise'].includes(a.action)) entries += 1;
    if (a.action === 'raise') {
      raiseCount += 1;
      if (raiseCount === 1) openerPos = pos;
    }
  }

  return tags;
}
