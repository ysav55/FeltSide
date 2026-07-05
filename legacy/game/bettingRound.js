'use strict';

/**
 * bettingRound.js — pure helper functions for the within-street action loop.
 *
 * All functions are stateless: they take explicit arguments and return values
 * without reading or writing GameManager state.
 */

/**
 * Returns true when the betting round is over:
 *   - no active non-all-in players remain, OR
 *   - every active non-all-in player has acted and matched the current bet.
 *
 * @param {object[]} activePlayers — only players where is_active && !is_all_in
 * @param {number}   currentBet   — the table's current_bet
 */
function isBettingRoundOver(activePlayers, currentBet) {
  if (activePlayers.length === 0) return true;
  return activePlayers.every(
    p => p.action !== 'waiting' && p.total_bet_this_round >= currentBet
  );
}

/**
 * Finds the next player to act after fromId.
 * Returns the player id or null if everyone is all-in/inactive.
 *
 * @param {object[]} players  — all seated (non-coach) players
 * @param {string}   fromId   — id of the player who just acted
 */
function findNextActingPlayer(players, fromId) {
  const currentIdx = players.findIndex(p => p.id === fromId);
  const n = players.length;
  for (let i = 1; i <= n; i++) {
    const p = players[(currentIdx + i) % n];
    if (p.is_active && !p.is_all_in) return p.id;
  }
  return null;
}

module.exports = { isBettingRoundOver, findNextActingPlayer };
