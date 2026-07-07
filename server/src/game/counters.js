/**
 * counters.js — per-participant booleans & opportunity counters
 * (CONTRACT §4.4). Pure: derived entirely from a completed hand record.
 *
 * Definitions (binding — tested against scripted hands):
 *
 * vpip           Voluntarily put chips in preflop: any preflop call, bet
 *                or raise. Posting blinds is not voluntary; a BB check is
 *                not VPIP; an SB *complete* (call) IS.
 * pfr            Raised preflop (any preflop raise, including a re-raise).
 * three_bet_opp  Faced exactly one preflop raise when the action reached
 *                them — i.e. they had the chance to make the 3-bet (the
 *                blind posts count as the first "bet", the open as the
 *                first raise).
 * three_bet      Took that chance: made the second preflop raise.
 * saw_flop       Still in the hand when the flop was dealt.
 * cbet_opp       Was the LAST preflop aggressor (final preflop raiser),
 *                saw the flop, and had the chance to make the first bet
 *                on the flop (nobody bet before their turn and they were
 *                not all-in). Limped pots have no aggressor → no opp.
 * cbet           Took that chance: their first flop action was a bet.
 * wtsd           Went to showdown: saw the flop and was still unfolded
 *                when a showdown occurred.
 * wsd            Won (any) chips at that showdown.
 * is_winner      Won any chips this hand (fold-win or showdown).
 */

export function computeCounters(record) {
  const { participants, showdownReached, winners } = record;
  // Undone actions are marked, never erased (M4) — stats ignore them.
  const actions = record.actions.filter((a) => !a.reverted);
  const preflop = actions.filter((a) => a.street === 'preflop');
  const flop = actions.filter((a) => a.street === 'flop');
  const flopDealt = record.board.length >= 3;

  // Last preflop aggressor = the final preflop raise, if any.
  const preflopRaises = preflop.filter((a) => a.action === 'raise');
  const lastAggressorId = preflopRaises.length
    ? preflopRaises[preflopRaises.length - 1].playerId
    : null;

  const out = {};
  for (const p of participants) {
    const mine = (list) => list.filter((a) => a.playerId === p.playerId);

    const vpip = mine(preflop).some((a) => ['call', 'bet', 'raise'].includes(a.action));
    const pfr = mine(preflop).some((a) => a.action === 'raise');

    // Walk preflop actions counting raises to find 3-bet opportunities.
    let raiseCount = 0;
    let threeBetOpp = false;
    let threeBet = false;
    for (const a of preflop) {
      if (a.playerId === p.playerId && !['post_sb', 'post_bb'].includes(a.action)) {
        if (raiseCount === 1) {
          threeBetOpp = true;
          if (a.action === 'raise') threeBet = true;
        }
      }
      if (a.action === 'raise') raiseCount += 1;
    }

    const foldedPreflop = mine(preflop).some((a) => a.action === 'fold');
    const sawFlop = flopDealt && !foldedPreflop;

    // C-bet: first flop action of the last preflop aggressor, provided no
    // one bet ahead of them on the flop.
    let cbetOpp = false;
    let cbet = false;
    if (lastAggressorId === p.playerId && sawFlop) {
      for (const a of flop) {
        if (a.playerId === p.playerId) {
          cbetOpp = true;
          cbet = a.action === 'bet';
          break;
        }
        if (a.action === 'bet') break; // someone bet ahead (donk) — no opp
      }
    }

    const foldedEver = mine(actions).some((a) => a.action === 'fold');
    const wtsd = sawFlop && showdownReached && !foldedEver;
    const wsd = wtsd && winners.includes(p.playerId);

    out[p.playerId] = {
      vpip, pfr,
      three_bet_opp: threeBetOpp, three_bet: threeBet,
      saw_flop: sawFlop,
      cbet_opp: cbetOpp, cbet,
      wtsd, wsd,
    };
  }
  return out;
}
