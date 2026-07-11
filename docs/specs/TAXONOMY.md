# TAXONOMY.md — Engine Tag Vocabulary v1

> Resolves CONTRACT.md Open Item #1. The `stat_key` column feeds the CRM's
> `TAG_MAPPING.md` verbatim. Tags with an empty `stat_key` are engine-only
> (review filtering / playlist building); the CRM skips-and-counts them by
> design.
>
> Structural decisions (locked): two auto classes — `descriptor` (neutral
> fact) and `mistake` (player-attributed judgment, the only class that
> becomes CRM leak observations) — plus manual `coach`. Sizing class cut
> (ratios derivable from `actions[].amount` + pot). Every mistake carries
> `action_seq`. Frequency leaks (e.g. "c-bets too often") are NOT engine
> tags — they are derived CRM-side from the exported per-participant
> booleans/opportunity counters via the existing outlier logic.

---

## 1. Descriptors — hand-level (`player_id: null`)

| Tag | Trigger rule |
|-----|-------------|
| `LIMPED_POT` | No preflop raise; at least one voluntary limp |
| `SINGLE_RAISED_POT` | Exactly one preflop raise |
| `THREE_BET_POT` | Exactly two preflop raises |
| `FOUR_BET_POT` | Three or more preflop raises |
| `SQUEEZE_POT` | A 3-bet made after an open plus ≥1 caller |
| `ALLIN_PREFLOP` | ≥2 players all-in before the flop |
| `MULTIWAY` | ≥3 players see the flop |
| `WALK` | Everyone folds to the big blind; no flop |
| `BOARD_MONOTONE` | Flop: three cards of one suit |
| `BOARD_TWO_TONE` | Flop: exactly two suits |
| `BOARD_RAINBOW` | Flop: three suits |
| `BOARD_PAIRED` | Flop contains a pair |
| `BOARD_CONNECTED` | Flop ranks span ≤ 4 (e.g. 9-8-6), unpaired |
| `BOARD_ACE_HIGH` | Flop contains an ace |
| `UNDO_USED` | Coach used undo/rollback during the hand (coached-table artifact — moved OUT of the mistake class) |

## 2. Descriptors — player-level (carry `player_id`, `action_seq`)

| Tag | Trigger rule |
|-----|-------------|
| `CBET_FLOP` | Preflop last aggressor makes the first bet on the flop |
| `DOUBLE_BARREL` | Same player bets the turn after `CBET_FLOP` |
| `TRIPLE_BARREL` | Same player bets the river after `DOUBLE_BARREL` |
| `DONK_BET` | OOP player bets into the previous street's aggressor before they act |
| `CHECK_RAISE` | Player checks, then raises on the same street |
| `PROBE_BET` | OOP player bets turn/river after the preflop aggressor checked back the prior street |
| `RIVER_RAISE` | Any raise on the river |
| `LIMP_RERAISE` | Player limps preflop, then re-raises over a raise behind (a line, not a verdict — intentional trap is legitimate) |
| `ALLIN_FAVORITE` | At all-in-and-call with no action remaining: equity > 60% |
| `ALLIN_UNDERDOG` | Same moment: equity < 40% |
| `ALLIN_FLIP` | Same moment: equity 40–60% (both players tagged) |
| `FOLDED_WINNER` | Player folds on the river holding a hand that beats every hand shown down. **Explicitly results-oriented** — review-filter gold, never a mistake. Requires a showdown to have occurred. |
| `MIN_RAISE_POSTFLOP` | Postflop raise of exactly the minimum (click-raise). A line, not a verdict — sometimes correct. |

## 3. Mistakes — absolute rules (carry `player_id`, `action_seq`)

| Tag | Trigger rule | stat_key |
|-----|-------------|----------|
| `OPEN_LIMP` | First voluntary entry is a limp (incl. SB complete) | `limp_behind` * |
| `OVERLIMP` | Limp behind ≥1 existing limper | `limp_behind` |
| `COLD_CALL_3BET` | Calls a 3-bet with no prior money invested in the pot | `call_3bet_oop` * |
| `MISSED_RIVER_VALUE` | Checks back river **in position** holding two pair or better (strength threshold coach-configurable, §6) | `missed_river_value` |

\* Approximate mappings, documented as such: `limp_behind`'s CRM description
is over-limping (we map both limp forms to it — the nearest key);
`call_3bet_oop` is position-scoped in the CRM while our tag fires in any
position.

## 4. Mistakes — chart engine (v1 feature; carry `player_id`, `action_seq`)

The engine holds **coach-defined reference charts**; every relevant decision
is compared against them. Deviations are decision-level evidence for exactly
the leaks the CRM's taxonomy cares most about.

**v1 chart set (per Jo):**
- Table sizes up to **9-max**. Open-raise chart per position (UTG, UTG+1,
  UTG+2, LJ, HJ, CO, BTN, SB); positions collapse via the standard position
  map at smaller tables.
- **Blind-defense charts**: BB and SB each get defend ranges keyed by opener
  position — covering blind-vs-blind (BB vs SB open) and BTN-vs-blind
  (SB/BB vs BTN open) explicitly.
- **Seeded with standard published ranges** so the analyzers judge from day
  one with zero setup. Every chart is coach-editable per situation via the
  range-matrix in the Analyzer Settings page (§6), with per-chart
  "reset to default".
- Phase 2 (explicitly out of v1): non-blind facing-open response charts,
  3-bet-defense charts, squeeze charts (→ future `MISSED_SQUEEZE` /
  `FOLD_VS_3BET_TIGHT`).

| Tag | Trigger rule | stat_key |
|-----|-------------|----------|
| `OPEN_TOO_LOOSE` | First-in raise with a hand outside the position's open chart | `open_too_loose` |
| `OPEN_TOO_TIGHT` | First-in fold holding a hand inside the position's open chart (the engine always knows hole cards — folds are judgeable) | `open_too_tight` |
| `BB_OVERFOLD` | BB folds vs a single open holding a hand inside the BB-defend chart for that opener position | `overfold_bb` |
| `SB_OVERFOLD` | SB folds vs a single open holding a hand inside the SB-defend chart for that opener position | — (engine-only; `overfold_bb` is BB-specific) |
| `BLIND_OVERDEFEND` | SB/BB defends (call/3-bet) vs an open with a hand outside the defend chart | — (engine-only) |

Chart tags fire on **all** hand origins — a chart deviation in a drill is
still evidence (per the locked counting policy: fabricated hands are
evidence-eligible, just stat-excluded).

## 5. Frequency leaks — NOT engine tags

Derived CRM-side from the exported per-participant booleans
(`vpip, pfr, three_bet_opp, three_bet, saw_flop, cbet_opp, cbet, wtsd, wsd`)
aggregated over `origin == "rng"` hands, through the CRM's existing
outlier machinery:

| CRM stat_key | Feeding fields |
|--------------|----------------|
| `vpip_pfr_gap` | vpip, pfr |
| `cbet_flop_high` / `cbet_flop_low` | cbet_opp, cbet |
| `wtsd_high` / `wtsd_low` | saw_flop, wtsd |

**Not yet derivable anywhere** (no counters, no absolute rule, no v1 chart):
`fold_to_3bet_high`, `squeeze_low`, `check_raise_low`, `cbet_turn_low`,
`double_barrel_low`, `fold_vs_turn_raise`, `river_overfold`,
`river_overcall`, `bluff_catch_wide`, `wtsd_low`-adjacent river keys, and all
`mental` keys. These remain fed by the CRM's session/LLM sources for now;
candidates for phase-2 counters or charts.

## 6. Analyzer Settings page (v1 feature)

Every parameter the analyzers consult is coach-tunable from a single
settings page:

- **Reference charts**: all open charts (per position) and defend charts
  (per blind × opener position), edited via the range matrix; per-chart
  "reset to default" restoring the seeded standard.
- **Per-tag kill switch**: any tag can be disabled globally.
- **Thresholds** (defaults in parentheses): all-in favorite/underdog equity
  bounds (60% / 40%); `MISSED_RIVER_VALUE` strength floor (two pair) and
  in-position-only toggle (on); `BOARD_CONNECTED` rank span (≤ 4);
  `MULTIWAY` player count (≥ 3).
- **Non-retroactive**: settings changes apply to future hands only. Bulk
  re-analysis of history is phase 2; the `revision` mechanism covers manual
  retags today.

## 7. Cut from the old system, with reasons

| Old tag(s) | Reason |
|------------|--------|
| All sizing tags (`PROBE_BET`→kept as line, `THIRD_POT_BET`, `HALF_POT_BET`, `POT_BET`, `OVERBET`, `OVERBET_JAM`) | Derivable from `amount`/pot by any consumer; tagging every bet is noise |
| `EQUITY_FOLD` | Judged folds against cards the player cannot see — that's poker, not a mistake |
| `EQUITY_FAVORITE/UNDERDOG/COIN_FLIP` (per street) | Kept only at the all-in moment where the judgment is fair (§2) |
| `BLUFF_CATCH`, `FOLD_TO_PROBE`, `SQUEEZE_LIMP` | Frequency/range questions masquerading as per-hand verdicts |
| `BTN_OPEN`, `BLIND_DEFENSE`, street-reach tags, `SHORT/DEEP_STACK`, `WHALE_POT` | Derivable from actions + positions + stacks already in the payload |
| `STRONG/MARGINAL/WEAK_HAND`, `BUSTED_DRAW` | Low signal; hand strength is visible in the replay |
| `WET/DRY_BOARD` | Fuzzy composite; monotone/paired/connected cover the filtering need |
