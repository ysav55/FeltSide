import { evaluate, compareHands } from '../game/HandEvaluator.js';
import { headsUpEquity } from './equity.js';
import {
  liveActions, voluntary, street, tag, preflopAggressor, streetAggressor,
  holeCardsOf, unfoldedIds,
} from './helpers.js';

const POSTFLOP = ['flop', 'turn', 'river'];
const BOARD_AT = { preflop: 0, flop: 3, turn: 4, river: 5 };

/** TAXONOMY §2 — player-level descriptors (player_id + action_seq). */
export function analyzePlayerDescriptors(record, { settings }) {
  const tags = [];
  const actions = liveActions(record);
  const pfAggressor = preflopAggressor(actions);

  // ── C-bet line: CBET_FLOP → DOUBLE_BARREL → TRIPLE_BARREL ────────────
  let cbetSeq = null;
  if (pfAggressor) {
    for (const a of street(actions, 'flop')) {
      if (a.action === 'bet') {
        if (a.playerId === pfAggressor) cbetSeq = a.seq;
        break; // first bet decides: aggressor → c-bet; other → no c-bet line
      }
    }
  }
  if (cbetSeq !== null) {
    tags.push(tag('CBET_FLOP', 'descriptor', pfAggressor, cbetSeq));
    const turnBet = street(actions, 'turn')
      .find((a) => a.playerId === pfAggressor && a.action === 'bet');
    if (turnBet) {
      tags.push(tag('DOUBLE_BARREL', 'descriptor', pfAggressor, turnBet.seq));
      const riverBet = street(actions, 'river')
        .find((a) => a.playerId === pfAggressor && a.action === 'bet');
      if (riverBet) {
        tags.push(tag('TRIPLE_BARREL', 'descriptor', pfAggressor, riverBet.seq));
      }
    }
  }

  // ── DONK_BET / PROBE_BET / CHECK_RAISE / RIVER_RAISE / MIN_RAISE ─────
  const prevStreet = { flop: 'preflop', turn: 'flop', river: 'turn' };
  for (const name of POSTFLOP) {
    const sa = street(actions, name);
    if (sa.length === 0) continue;
    const prevAggr = streetAggressor(actions, prevStreet[name]) ??
      (prevStreet[name] === 'preflop' ? pfAggressor : null);

    // DONK_BET: first bet of the street, by a non-aggressor, before the
    // previous street's aggressor has acted this street.
    const firstBet = sa.find((a) => a.action === 'bet');
    if (firstBet && prevAggr && firstBet.playerId !== prevAggr) {
      const aggrActedBefore = sa.some(
        (a) => a.playerId === prevAggr && a.seq < firstBet.seq
      );
      if (!aggrActedBefore) {
        tags.push(tag('DONK_BET', 'descriptor', firstBet.playerId, firstBet.seq));
      }
    }

    // PROBE_BET (turn/river): OOP bets after the preflop aggressor checked
    // back the prior street (prior street had no bet at all).
    if ((name === 'turn' || name === 'river') && pfAggressor && firstBet &&
        firstBet.playerId !== pfAggressor) {
      const prior = street(actions, prevStreet[name]);
      const priorHadBet = prior.some((a) => ['bet', 'raise'].includes(a.action));
      const aggressorCheckedPrior = prior.some(
        (a) => a.playerId === pfAggressor && a.action === 'check'
      );
      const aggrActedBefore = sa.some(
        (a) => a.playerId === pfAggressor && a.seq < firstBet.seq
      );
      if (!priorHadBet && aggressorCheckedPrior && !aggrActedBefore) {
        tags.push(tag('PROBE_BET', 'descriptor', firstBet.playerId, firstBet.seq));
      }
    }

    // CHECK_RAISE: check then raise on the same street.
    const checkedThisStreet = new Set();
    for (const a of sa) {
      if (a.action === 'check') checkedThisStreet.add(a.playerId);
      if (a.action === 'raise' && checkedThisStreet.has(a.playerId)) {
        tags.push(tag('CHECK_RAISE', 'descriptor', a.playerId, a.seq));
      }
    }

    // RIVER_RAISE: any raise on the river.
    if (name === 'river') {
      for (const a of sa) {
        if (a.action === 'raise') {
          tags.push(tag('RIVER_RAISE', 'descriptor', a.playerId, a.seq));
        }
      }
    }

    // MIN_RAISE_POSTFLOP: raise of exactly the legal minimum (click-raise).
    let currentBet = 0;
    let lastRaiseSize = 0;
    for (const a of sa) {
      if (a.action === 'bet') {
        currentBet = a.amount;
        lastRaiseSize = a.amount;
      } else if (a.action === 'raise') {
        const minTo = currentBet + lastRaiseSize;
        if (a.amount === minTo) {
          tags.push(tag('MIN_RAISE_POSTFLOP', 'descriptor', a.playerId, a.seq));
        }
        lastRaiseSize = a.amount - currentBet;
        currentBet = a.amount;
      }
    }
  }

  // ── LIMP_RERAISE: limp, then re-raise over a raise behind ────────────
  const preflop = voluntary(street(actions, 'preflop'));
  {
    let raiseCount = 0;
    const limped = new Set();
    for (const a of preflop) {
      if (a.action === 'call' && raiseCount === 0) limped.add(a.playerId);
      if (a.action === 'raise') {
        if (raiseCount >= 1 && limped.has(a.playerId)) {
          tags.push(tag('LIMP_RERAISE', 'descriptor', a.playerId, a.seq));
        }
        raiseCount += 1;
      }
    }
  }

  // ── ALLIN_FAVORITE / UNDERDOG / FLIP at the all-in-and-call moment ───
  const closingCall = findClosingAllInCall(record, actions);
  if (closingCall) {
    const { seq, streetName, pair } = closingCall;
    const [p1, p2] = pair;
    const h1 = holeCardsOf(record, p1);
    const h2 = holeCardsOf(record, p2);
    if (h1 && h2) {
      const board = record.board.slice(0, BOARD_AT[streetName]);
      const [e1, e2] = headsUpEquity(h1, h2, board);
      const fav = settings.thresholds.allinFavoritePct ?? 60;
      const dog = settings.thresholds.allinUnderdogPct ?? 40;
      const classify = (eq) => (eq > fav ? 'ALLIN_FAVORITE' : eq < dog ? 'ALLIN_UNDERDOG' : 'ALLIN_FLIP');
      tags.push(tag(classify(e1), 'descriptor', p1, seq));
      tags.push(tag(classify(e2), 'descriptor', p2, seq));
    }
  }

  // ── FOLDED_WINNER: river fold that beat every shown-down hand ────────
  if (record.showdownReached) {
    const shown = record.participants.filter((p) => !p.folded && p.holeCards);
    const riverFolds = street(actions, 'river').filter((a) => a.action === 'fold');
    for (const foldAction of riverFolds) {
      const hole = holeCardsOf(record, foldAction.playerId);
      if (!hole || shown.length === 0) continue;
      const foldedHand = evaluate(hole, record.board);
      const beatsAll = shown.every(
        (p) => compareHands(foldedHand, evaluate(p.holeCards, record.board)) > 0
      );
      if (beatsAll) {
        tags.push(tag('FOLDED_WINNER', 'descriptor', foldAction.playerId, foldAction.seq));
      }
    }
  }

  return tags;
}

/**
 * The all-in-and-call moment with no action remaining: a call after which
 * no further non-reverted actions exist, exactly two live players, at
 * least one all-in. Multiway all-ins are out of v1 (pairwise equity is
 * ambiguous evidence).
 */
function findClosingAllInCall(record, actions) {
  const vol = voluntary(actions);
  const last = vol[vol.length - 1];
  if (!last || last.action !== 'call') return null;
  const live = unfoldedIds(record);
  if (live.length !== 2) return null;
  const anyAllIn = actions.some((a) => a.allIn && live.includes(a.playerId));
  if (!anyAllIn) return null;
  if (!record.showdownReached) return null;
  return { seq: last.seq, streetName: last.street, pair: live };
}
