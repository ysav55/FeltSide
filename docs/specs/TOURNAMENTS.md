# TOURNAMENTS.md — Tournament System Spec (v1)

> Resolves PRD_SKELETON §11.2. One tournament system (the old A/B split is
> dead). Autonomous by default; the coach configures ahead and intervenes at
> will. Scale target: up to 6 concurrent tables, ~50 players max, realistic
> fields 6–30. Defaults follow live-poker standards (TDA balancing, standard
> small-field payouts) so students practice under real-world conventions.

---

## 1. Preset schema

Presets are engine-side objects (CONTRACT §4.7 exports the catalog; the CRM
schedules by reference). Coach-editable; seeded set below.

```python
preset = {
  "name": str, "description": str,
  "buy_in": int,                    # bankroll chips
  "table_size": 6 | 9,
  "starting_stack_bb": int,         # stack derived: bb_level1 * this
  "level_duration_min": int,
  "blind_ladder": [                 # explicit, editable; generated default
    {"level": 1, "sb": 100, "bb": 200, "bb_ante": 0},
    ...
  ],
  "ante": {"type": "bb_ante", "from_level": int} | {"type": "none"},
  "late_reg_until_level": int,      # join with full stack until this level
  "reentry": {"allowed": bool, "until_level": int, "max": int},
  "addon": {"allowed": bool, "at_break_after_level": int, "chips": int},
  "breaks": {"every_n_levels": int, "minutes": int},
  "action_timer_sec": int,          # default 30; no time bank in v1
  "payout_table": "standard" | [percentages],   # §5
  "icm_overlay": bool,              # live ICM $EV display to players
  "deals_enabled": bool             # ICM deal proposal at final table
}
```

**Command decisions baked in (veto any):**
- **Re-entry only, no rebuys.** Modern standard; a bust is a bust, re-enter
  with a fresh full stack while re-entry is open. Rebuy-while-stacked is
  cut.
- **BB ante**, not individual antes, from the configured level — the modern
  live standard, and one fewer action per player per hand.
- **No time bank v1** — flat action timer; timeouts auto-check/fold.

## 2. Seeded presets

| Name | Stack | Levels | Target duration | Use |
|------|-------|--------|-----------------|-----|
| Lesson Turbo | 50 BB | 8 min | ~75 min | inside a lesson slot |
| Standard Evening | 75 BB | 15 min | ~2.5 h | the weekly school event |
| Deep Teach | 150 BB | 25 min | ~4 h | deep-stack play practice |
| Hyper | 30 BB | 5 min | ~40 min | push/fold & ICM drills |

Ladders generated at ~30–40% blind increases per level, BB ante from
level 4 (Turbo/Hyper: level 3). All editable per preset.

## 3. Lifecycle (autonomous state machine)

```
scheduled → registering → running → completed
                              ↳ paused (coach)
```

- **scheduled:** created manually or via CRM push (CONTRACT §8). Visible in
  lobby with start time.
- **registering:** players register (bankroll debited). Auto-start at
  scheduled time if ≥ minimum players (default 4); otherwise waits for the
  coach.
- **running:** level timer advances automatically; breaks fire on schedule;
  late reg and re-entry windows enforced by level; eliminations are
  automatic when a hand completes with a stack at 0 (re-entry offered if
  window open). Simultaneous bust-outs: the player who started the hand
  with more chips finishes higher (standard).
- **Hand-for-hand:** automatic when one elimination reaches the money —
  all tables synchronize hand starts until the bubble bursts.
- **completed:** payouts applied to bankrolls automatically (§5); session
  exported with finish positions (CONTRACT §4.3).

## 4. Multi-table: balancing & breaking (TDA-derived)

- **Auto-balance trigger:** table sizes differ by ≥ 2. The player due BB
  next at the largest table moves to the seat closest behind the BB at the
  smallest table. **Stack size is never a factor.**
- **Breaking:** when the field fits in one fewer table, the last-created
  table breaks; its players get a full random seat draw across remaining
  tables. Final table: full random redraw.
- **Manual balance (Jo's requirement):** the coach can move any player to
  any open seat at any time from the tournament control panel; auto-balance
  resumes around whatever he did. Auto-balance can also be disabled
  per-tournament (pure manual mode).
- Moves happen between hands only; a moved player never misses more than
  one hand and never posts a double blind (dead-button rules).

## 5. Payouts (closed bankroll economy)

Prize pool = all buy-ins + re-entries + add-ons. Paid automatically to
bankrolls at completion. Default "standard" table by field size:

| Field | Places | Split |
|-------|--------|-------|
| 2–5 | 1 | 100 |
| 6–9 | 2 | 65 / 35 |
| 10–13 | 3 | 50 / 30 / 20 |
| 14–18 | 4 | 40 / 25 / 20 / 15 |
| 19–27 | 5 | 38 / 24 / 16 / 12 / 10 |
| 28–54 | 6 | 33 / 21 / 15 / 12 / 10 / 9 |

Rounding remainder goes to first place (standard practice).

## 6. Coach postures & interventions

Both locked postures supported: **managing without sitting** (control panel
only) and **sitting without managing** (plays as a regular player; the
tournament needs no manager). Interventions, available in both:

- Pause / resume (freezes level clock and action timers everywhere).
- Advance level now / extend current level.
- Manual player move (§4). Manual eliminate (edge cases: no-show cleanup).
- **End early:** stops the tournament and pays by current chip-count
  ranking — the lesson-overrun escape hatch.
- Registration overrides: admit past late-reg, grant a re-entry outside the
  window (soft limits, same philosophy as lesson seat restriction).

## 7. ICM (teaching features)

- **ICM overlay** (per-preset flag): live $EV of each stack shown to
  players — bubble/payout-pressure teaching made visible.
- **Deal proposal** (per-preset flag): at the final table the coach can
  trigger an ICM deal proposal; unanimous accept ends the tournament with
  ICM payouts. Kept from the old system — deal math is also lesson
  material and a time-control tool.

## 8. Player-absence rules

Tournament seats are never vacated by disconnect: blinds and antes post in
absentia, hands auto-fold on timer. Reconnection resumes the seat. (Unlike
uncoached cash, there is no sit-out choice in a tournament.)

## 9. Out of v1

- Time banks; shot clocks per player.
- Multi-day / pause-and-resume-tomorrow tournaments.
- Satellites, bounties/knockouts, PKO math.
- Playlist/scenario injection into tournament hands (explicitly far-future
  per Jo).
- Multi-table grid view for the coach (fast table switching instead).
