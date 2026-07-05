'use strict';

/**
 * ShowdownResolver.js — pure showdown computation.
 *
 * resolve() takes immutable player snapshots and pot info; returns a result
 * object describing chip awards. GameManager._resolveShowdown() applies the
 * returned stack deltas and stores the showdown_result.
 */

const { evaluate, compareHands } = require('./HandEvaluator');
const { buildSidePots } = require('./SidePotCalculator');

/**
 * Sort winner entries by proximity to the small blind seat (clockwise).
 * The first winner in the sorted list receives any remainder chip.
 *
 * @param {object[]} winners    — entries with { player: { seat }, ... }
 * @param {object[]} allPlayers — all seated players (for seat range)
 */
function _sortBySBProximity(winners, allPlayers) {
  const sbPlayer = allPlayers.find(p => p.is_small_blind);
  const sbSeat   = sbPlayer ? sbPlayer.seat : 0;
  const allSeats  = allPlayers.map(p => p.seat);
  const numSeats  = Math.max(...allSeats) + 1;
  return [...winners].sort((a, b) => {
    const distA = (a.player.seat - sbSeat + numSeats) % numSeats;
    const distB = (b.player.seat - sbSeat + numSeats) % numSeats;
    return distA - distB;
  });
}

/**
 * Resolve a showdown.
 *
 * @param {object[]} activePlayers — players still in the hand (is_active)
 * @param {object[]} allPlayers    — all seated players (for SB proximity sort)
 * @param {string[]} board         — 5-card community board
 * @param {number}   pot           — total pot size
 *
 * @returns {{
 *   showdown_result: object,
 *   stackDeltas: Map<string, number>,   // playerId → chip delta (can be negative from blind)
 *   pot: number,                        // 0 after award
 *   winner: string|null,
 *   winner_name: string|null,
 *   side_pots: object[],
 * }}
 */
function resolve(activePlayers, allPlayers, board, pot) {
  // Evaluate each active player's hand once
  const handMap = {};
  activePlayers.forEach(p => {
    handMap[p.id] = evaluate(p.hole_cards, board);
  });

  // All hands sorted best → worst (for ShowdownResult.allHands)
  const evaluatedAll = activePlayers
    .map(p => ({ player: p, handResult: handMap[p.id] }))
    .sort((a, b) => compareHands(b.handResult, a.handResult));

  const sidePots = buildSidePots(allPlayers);
  const stackDeltas = new Map();

  let showdown_result;
  let winner     = null;
  let winner_name = null;
  let side_pots  = [];

  if (sidePots.length > 0) {
    // ── Multi-pot path ─────────────────────────────────────────────────────────
    const sidePotResults = [];
    let totalAwarded = 0;

    for (const pot of sidePots) {
      const eligible = activePlayers.filter(p => pot.eligiblePlayerIds.includes(p.id) && handMap[p.id]);
      if (eligible.length === 0) continue;

      const ranked = eligible
        .map(p => ({ player: p, handResult: handMap[p.id] }))
        .sort((a, b) => compareHands(b.handResult, a.handResult));

      const best       = ranked[0].handResult;
      const potWinners = ranked.filter(e => compareHands(e.handResult, best) === 0);
      const share      = Math.floor(pot.amount / potWinners.length);
      const remainder  = pot.amount - share * potWinners.length;
      const sorted     = _sortBySBProximity(potWinners, allPlayers);

      sorted.forEach((e, idx) => {
        const award = share + (idx === 0 ? remainder : 0);
        stackDeltas.set(e.player.id, (stackDeltas.get(e.player.id) || 0) + award);
      });
      totalAwarded += pot.amount;

      sidePotResults.push({
        potAmount: pot.amount,
        eligiblePlayerIds: pot.eligiblePlayerIds,
        winners: sorted.map((e, idx) => ({
          playerId: e.player.id,
          playerName: e.player.name,
          handResult: e.handResult,
          potAwarded: share + (idx === 0 ? remainder : 0),
        })),
      });
    }

    side_pots = sidePots;
    const mainPotWinners = sidePotResults[sidePotResults.length - 1]?.winners ?? [];
    winner      = mainPotWinners[0]?.playerId ?? null;
    winner_name = mainPotWinners[0]?.playerName ?? null;

    showdown_result = {
      winners: mainPotWinners.map(w => ({
        playerId: w.playerId, playerName: w.playerName, handResult: w.handResult,
      })),
      allHands: evaluatedAll.map(e => ({
        playerId: e.player.id, playerName: e.player.name, handResult: e.handResult,
      })),
      potAwarded: totalAwarded,
      splitPot: mainPotWinners.length > 1,
      sidePotResults,
    };

  } else {
    // ── Single-pot path ────────────────────────────────────────────────────────
    const best         = evaluatedAll[0].handResult;
    const winnerEntries = evaluatedAll.filter(e => compareHands(e.handResult, best) === 0);
    const share        = Math.floor(pot / winnerEntries.length);
    const remainder    = pot - share * winnerEntries.length;
    const sorted       = _sortBySBProximity(winnerEntries, allPlayers);

    sorted.forEach((e, idx) => {
      const award = share + (idx === 0 ? remainder : 0);
      stackDeltas.set(e.player.id, (stackDeltas.get(e.player.id) || 0) + award);
    });

    winner      = sorted[0].player.id;
    winner_name = sorted[0].player.name;

    showdown_result = {
      winners: winnerEntries.map(e => ({
        playerId: e.player.id, playerName: e.player.name, handResult: e.handResult,
      })),
      allHands: evaluatedAll.map(e => ({
        playerId: e.player.id, playerName: e.player.name, handResult: e.handResult,
      })),
      potAwarded: pot,
      splitPot: winnerEntries.length > 1,
    };
  }

  return { showdown_result, stackDeltas, pot: 0, winner, winner_name, side_pots };
}

module.exports = { resolve, sortBySBProximity: _sortBySBProximity };
