/**
 * Engine tag vocabulary v1 — the single source of truth (TAXONOMY.md §§1–4).
 *
 * Exported verbatim by /export/v1/meta (CONTRACT §4.1) and imported by the
 * M5 analyzers, so the vocabulary the CRM maps against and the vocabulary
 * the analyzers emit can never drift apart.
 *
 * tag_type: 'descriptor' (neutral fact) | 'mistake' (player-attributed
 * judgment — the only class eligible to become CRM leak observations).
 * The manual 'coach' class is free-text and has no vocabulary entry.
 */

export const TAG_VOCABULARY_VERSION = 1;

export const TAG_VOCABULARY = Object.freeze([
  // ── TAXONOMY §1 — descriptors, hand-level (player_id: null) ──────────
  { tag: 'LIMPED_POT', tag_type: 'descriptor', description: 'No preflop raise; at least one voluntary limp' },
  { tag: 'SINGLE_RAISED_POT', tag_type: 'descriptor', description: 'Exactly one preflop raise' },
  { tag: 'THREE_BET_POT', tag_type: 'descriptor', description: 'Exactly two preflop raises' },
  { tag: 'FOUR_BET_POT', tag_type: 'descriptor', description: 'Three or more preflop raises' },
  { tag: 'SQUEEZE_POT', tag_type: 'descriptor', description: 'A 3-bet made after an open plus at least one caller' },
  { tag: 'ALLIN_PREFLOP', tag_type: 'descriptor', description: 'Two or more players all-in before the flop' },
  { tag: 'MULTIWAY', tag_type: 'descriptor', description: 'Three or more players see the flop' },
  { tag: 'WALK', tag_type: 'descriptor', description: 'Everyone folds to the big blind; no flop' },
  { tag: 'BOARD_MONOTONE', tag_type: 'descriptor', description: 'Flop: three cards of one suit' },
  { tag: 'BOARD_TWO_TONE', tag_type: 'descriptor', description: 'Flop: exactly two suits' },
  { tag: 'BOARD_RAINBOW', tag_type: 'descriptor', description: 'Flop: three suits' },
  { tag: 'BOARD_PAIRED', tag_type: 'descriptor', description: 'Flop contains a pair' },
  { tag: 'BOARD_CONNECTED', tag_type: 'descriptor', description: 'Flop ranks span 4 or less (e.g. 9-8-6), unpaired' },
  { tag: 'BOARD_ACE_HIGH', tag_type: 'descriptor', description: 'Flop contains an ace' },
  { tag: 'UNDO_USED', tag_type: 'descriptor', description: 'Coach used undo/rollback during the hand (coached-table artifact)' },

  // ── TAXONOMY §2 — descriptors, player-level (player_id + action_seq) ─
  { tag: 'CBET_FLOP', tag_type: 'descriptor', description: 'Preflop last aggressor makes the first bet on the flop' },
  { tag: 'DOUBLE_BARREL', tag_type: 'descriptor', description: 'Same player bets the turn after CBET_FLOP' },
  { tag: 'TRIPLE_BARREL', tag_type: 'descriptor', description: 'Same player bets the river after DOUBLE_BARREL' },
  { tag: 'DONK_BET', tag_type: 'descriptor', description: "OOP player bets into the previous street's aggressor before they act" },
  { tag: 'CHECK_RAISE', tag_type: 'descriptor', description: 'Player checks, then raises on the same street' },
  { tag: 'PROBE_BET', tag_type: 'descriptor', description: 'OOP player bets turn/river after the preflop aggressor checked back the prior street' },
  { tag: 'RIVER_RAISE', tag_type: 'descriptor', description: 'Any raise on the river' },
  { tag: 'LIMP_RERAISE', tag_type: 'descriptor', description: 'Player limps preflop, then re-raises over a raise behind (a line, not a verdict)' },
  { tag: 'ALLIN_FAVORITE', tag_type: 'descriptor', description: 'At all-in-and-call with no action remaining: equity above 60%' },
  { tag: 'ALLIN_UNDERDOG', tag_type: 'descriptor', description: 'At all-in-and-call with no action remaining: equity below 40%' },
  { tag: 'ALLIN_FLIP', tag_type: 'descriptor', description: 'At all-in-and-call with no action remaining: equity 40–60% (both players tagged)' },
  { tag: 'FOLDED_WINNER', tag_type: 'descriptor', description: 'Player folds on the river holding a hand that beats every hand shown down (results-oriented; requires a showdown)' },
  { tag: 'MIN_RAISE_POSTFLOP', tag_type: 'descriptor', description: 'Postflop raise of exactly the minimum (click-raise); a line, not a verdict' },

  // ── TAXONOMY §3 — mistakes, absolute rules ───────────────────────────
  { tag: 'OPEN_LIMP', tag_type: 'mistake', description: 'First voluntary entry is a limp (incl. SB complete)' },
  { tag: 'OVERLIMP', tag_type: 'mistake', description: 'Limp behind one or more existing limpers' },
  { tag: 'COLD_CALL_3BET', tag_type: 'mistake', description: 'Calls a 3-bet with no prior money invested in the pot' },
  { tag: 'MISSED_RIVER_VALUE', tag_type: 'mistake', description: 'Checks back river in position holding two pair or better (threshold coach-configurable)' },

  // ── TAXONOMY §4 — mistakes, chart engine ─────────────────────────────
  { tag: 'OPEN_TOO_LOOSE', tag_type: 'mistake', description: "First-in raise with a hand outside the position's open chart" },
  { tag: 'OPEN_TOO_TIGHT', tag_type: 'mistake', description: "First-in fold holding a hand inside the position's open chart" },
  { tag: 'BB_OVERFOLD', tag_type: 'mistake', description: 'BB folds vs a single open holding a hand inside the BB-defend chart for that opener position' },
  { tag: 'SB_OVERFOLD', tag_type: 'mistake', description: 'SB folds vs a single open holding a hand inside the SB-defend chart for that opener position' },
  { tag: 'BLIND_OVERDEFEND', tag_type: 'mistake', description: 'SB/BB defends (call/3-bet) vs an open with a hand outside the defend chart' },
]);
