/**
 * SidePotCalculator.js
 *
 * Pure utility — no side effects, no state mutation.
 *
 * Exports:
 *   buildSidePots(players) → SidePot[]
 *
 * SidePot schema:
 *   { amount: number, eligiblePlayerIds: string[] }
 *
 * Input players must carry:
 *   id               {string}  — socket id
 *   total_contributed {number} — cumulative chips put into pot across ALL streets this hand
 *   is_active        {boolean} — false when the player has folded; true for all-in players
 *   is_all_in        {boolean}
 *
 * Algorithm (per AGENT_MEMORY.md ## SidePot Schema):
 *   1. If fewer than 2 players have total_contributed > 0, return [].
 *   2. Collect unique contribution levels from all-in players only (the breakpoints).
 *      If no players are all-in, return [] — single main pot, no side-pot split needed.
 *   3. Append max(total_contributed) across ALL players as the final level.
 *   4. Sort levels ascending, deduplicate.
 *   5. For each level L (prev = previous level, 0 for first):
 *        amount = Σ [ min(p.total_contributed, L) - min(p.total_contributed, prev) ]
 *                 for ALL players (folded players' chips still count toward the pot amount)
 *        eligiblePlayerIds = players where total_contributed >= L AND is_active === true
 *                            (folded players cannot win but their chips are in the pot)
 *        Only include the pot if amount > 0.
 *   6. Return the ordered SidePot[] (smallest contribution level first).
 */

/**
 * buildSidePots — compute side pots from player contribution totals.
 *
 * @param  {Object[]} players  All non-coach player objects for the current hand.
 * @returns {Array<{ amount: number, eligiblePlayerIds: string[] }>}
 */
function buildSidePots(players) {
  // ── Guard: null/undefined input ──────────────────────────────────────────────
  if (!players) return [];

  // ── Guard: need at least 2 players with positive contributions ───────────────
  const contributors = players.filter(p => p.total_contributed > 0);
  if (contributors.length < 2) {
    return [];
  }

  // ── Guard: no all-in players → no side-pot split needed ─────────────────────
  const allInPlayers = players.filter(p => p.is_all_in === true);
  if (allInPlayers.length === 0) {
    return [];
  }

  // ── Step 3: collect unique all-in levels and append max contribution ─────────
  const levelSet = new Set(allInPlayers.map(p => p.total_contributed));
  const maxContributed = Math.max(...players.map(p => p.total_contributed));
  levelSet.add(maxContributed);

  // ── Step 4: sort ascending ───────────────────────────────────────────────────
  const levels = Array.from(levelSet).sort((a, b) => a - b);

  // ── Step 5: walk levels and build pots ───────────────────────────────────────
  const sidePots = [];
  let prevLevel = 0;

  for (const L of levels) {
    // Amount: each player contributes the slice of their total between prevLevel and L
    let amount = 0;
    for (const p of players) {
      const contrib = Math.min(p.total_contributed, L)
                    - Math.min(p.total_contributed, prevLevel);
      if (contrib > 0) {
        amount += contrib;
      }
    }

    if (amount > 0) {
      // Eligible: contributed at least L AND still active (not folded).
      // ISS-06: all-in players have is_active === true (they haven't folded), so they
      // are correctly included here. The combination is_active=false + is_all_in=true
      // cannot occur in normal play — a player must fold voluntarily to become inactive.
      const eligiblePlayerIds = players
        .filter(p => p.total_contributed >= L && p.is_active === true)
        .map(p => p.id);

      sidePots.push({ amount, eligiblePlayerIds });
    }

    prevLevel = L;
  }

  // ── If only one pot and all active players are eligible, it's effectively
  //    the main pot (no split needed) — return [] like the no-all-in case ──────
  if (sidePots.length === 1) {
    const activePlayers = players.filter(p => p.is_active === true);
    if (sidePots[0].eligiblePlayerIds.length === activePlayers.length) {
      return [];
    }
  }

  return sidePots;
}

module.exports = { buildSidePots };
