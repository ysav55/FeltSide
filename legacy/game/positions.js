'use strict';

/**
 * Poker position utilities.
 *
 * Maps player seat numbers to canonical position names (BTN, SB, BB, UTG, ...)
 * relative to the dealer (button) seat. Used by the hand analyzer and written
 * to hand_actions.position at record time.
 *
 * Offset convention: clockwise distance from the dealer seat.
 *   offset 0 = BTN
 *   offset 1 = SB
 *   offset 2 = BB
 *   offset 3+ = UTG outward to CO
 *
 * Heads-up (2 players): BTN is also the SB in real poker, but we label it BTN
 * for consistency with the rest of the position system.
 */

const POSITION_NAMES = {
  2: ['BTN', 'BB'],
  3: ['BTN', 'SB', 'BB'],
  4: ['BTN', 'SB', 'BB', 'UTG'],
  5: ['BTN', 'SB', 'BB', 'UTG', 'CO'],
  6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
  7: ['BTN', 'SB', 'BB', 'UTG', 'MP', 'HJ', 'CO'],
  8: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO'],
  9: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'MP', 'HJ', 'CO'],
};

/**
 * Return the canonical position name for a single player.
 *
 * @param {Array}  seated     - hand_players rows filtered to seat >= 0, sorted by seat asc
 * @param {number} dealerSeat - seat number of the button/dealer
 * @param {string} playerId   - player_id to look up
 * @returns {string|null}     - position name, or null if player not found / dealerSeat invalid
 */
function getPosition(seated, dealerSeat, playerId) {
  const map = buildPositionMap(seated, dealerSeat);
  return map[playerId] ?? null;
}

/**
 * Build a { [playerId]: positionName } map for all seated players.
 *
 * @param {Array}  seated     - hand_players rows filtered to seat >= 0, sorted by seat asc
 * @param {number} dealerSeat - seat number of the button/dealer
 * @returns {Object}          - map of player_id → position name (empty if inputs invalid)
 */
function buildPositionMap(seated, dealerSeat) {
  if (!seated || seated.length < 2) return {};

  const dealerIdx = seated.findIndex(p => p.seat === dealerSeat);
  if (dealerIdx === -1) return {};

  const n = seated.length;
  const names = POSITION_NAMES[n] ?? POSITION_NAMES[9];
  const result = {};

  for (let offset = 0; offset < n; offset++) {
    const player = seated[(dealerIdx + offset) % n];
    result[player.player_id] = names[offset] ?? `P${offset}`;
  }

  return result;
}

/**
 * Returns true if playerA is in position (acts after) playerB postflop.
 * Uses clockwise offset from dealer: higher offset = acts later = in position.
 *
 * @param {Object} positionMap  - output of buildPositionMap
 * @param {Array}  seated       - same seated array used to build the map
 * @param {number} dealerSeat
 * @param {string} playerIdA
 * @param {string} playerIdB
 * @returns {boolean|null}      - null if either player not found
 */
function isInPosition(seated, dealerSeat, playerIdA, playerIdB) {
  const dealerIdx = seated.findIndex(p => p.seat === dealerSeat);
  if (dealerIdx === -1) return null;
  const n = seated.length;

  const idxA = seated.findIndex(p => p.player_id === playerIdA);
  const idxB = seated.findIndex(p => p.player_id === playerIdB);
  if (idxA === -1 || idxB === -1) return null;

  const offsetA = (idxA - dealerIdx + n) % n;
  const offsetB = (idxB - dealerIdx + n) % n;

  // Postflop acts in reverse: BTN (offset 0) acts last, SB (offset 1) acts first.
  // Lower offset = acts later postflop = in position.
  return offsetA < offsetB;
}

module.exports = { getPosition, buildPositionMap, isInPosition, POSITION_NAMES };
