# 0013 — M8.6 Known Gaps (numbered, severity-tagged)

The M8.6 conformance audit (docs/ops/M8-conformance-audit.md) walked the PRD
and all five specs against the code. HIGH + correctness MEDIUMs were fixed
with tests (see the audit table). The items below are the deviations
**deliberately not fixed in M8** — because M8 hardens and does not add
features, or because the fix needs a product/cost decision that is Jo's, or
because they are low-impact edge/ergonomic items. Logged here so the
constitution and the code no longer silently disagree.

Each gap says: severity, the spec clause, what the code does, why it is
deferred, and the fix direction.

---

## KG-1 — No scale-to-zero "pin awake" guard — MEDIUM (RUNTIME §1)
**Spec:** "the idle shutdown timer may fire ONLY when zero tables are active.
An active tournament or seated cash table pins the machine awake."
**Code:** delegated entirely to Fly's connection-based `auto_stop_machines`.
An autonomous tournament whose players all disconnected has zero sockets, so
Fly may stop the machine; it resumes (and `recover()` rebuilds at the
persisted clock) when someone reconnects — i.e. it *pauses*, not corrupts.
Now that the mid-hand snapshot bug is fixed (audit #1), a stop mid-hand voids
that hand cleanly (bets returned), so the worst case is a clean pause + one
voided hand.
**Why deferred:** a true fix is `min_machines_running = 1` in `fly.toml`
(never scale to zero — a recurring cost), traded against the current
scale-to-zero savings. That is a spend decision for Jo, not an engineering
default.
**Fix direction:** either set `min_machines_running = 1` (accept always-on
cost), or add a lightweight keep-alive that holds the machine up while
`tableService` has any active (non-scheduled) table.

## KG-2 — Seed charts are approximations, not published ranges — MEDIUM (TAXONOMY §4)
**Spec:** chart mistakes judged against "standard published ranges."
**Code:** `analyzers/defaults.js` seeds conventional-shape charts (live
sources were unreachable at M5) and says so. OPEN_TOO_LOOSE/TIGHT and the
blind-defense tags are `mistake`-class and exported, so any deviation from
true published ranges yields imperfect leak observations until a coach edits
the charts (which they can, per §6).
**Why deferred:** sourcing and transcribing authoritative ranges is content
work, not hardening; the mechanism is correct and coach-tunable.
**Fix direction:** replace the seed chart cells with a vetted published range
set; no code change needed (settings-editable).

## KG-3 — Dealing panel has no button/position control — MEDIUM (DEALING §2)
**Spec:** §2 lists a "position/button control" among the panel rows.
**Code:** the button is set only via scenario apply or branch, not from the
live panel; no `coach:command` for it.
**Why deferred:** it is a new panel feature; M8 adds none.
**Fix direction:** add a `panel:button` coach command + a `setButton(seatIndex)`
on `CoachedTableRuntime`, and a control in `DealingPanel.jsx`.

## KG-4 — No "RNG the rest of this hand" escape — MEDIUM (DEALING §3)
**Spec:** §3 escape hatch: "RNG the rest of this street / **this hand**."
**Code:** `rngRest()` releases only the currently-pending street; with turn
and river both manual, releasing the turn re-enters `awaiting_deal` on the
river.
**Why deferred:** new affordance; M8 adds none.
**Fix direction:** add a variant that sets all remaining street policies to
`rng` (or `auto`) and fills, in one action.

## KG-5 — `rowCount`-only delete checks — LOW (carried from decisions/0011)
`tablesRepo.deleteScheduled`, `scenariosRepo.remove`, `playlistsRepo.remove`
read `r.rowCount` only. Correct on prod `pg`; on PGlite (`affectedRows`) they
would misreport "deleted: false". Prod-correct today; `tournamentsRepo`
already uses the `affected()` helper as the pattern to copy.
**Fix direction:** wrap each in `r.rowCount ?? r.affectedRows ?? 0`.

## KG-6 — Sync request wrapper undocumented — LOW (CONTRACT §8)
The engine requires `PUT /sync/v1/lessons` bodies shaped `{entries:[...]}`,
and the CRM sends exactly that — but CONTRACT §8 documents only the per-entry
shape, never the wrapper. Both sides agree; the spec text is silent.
**Fix direction:** add one line to CONTRACT §8 documenting the `{entries:[]}`
envelope.

## KG-7 — Dealing panel keyboard ergonomics — LOW (DEALING §2)
No `B`-key jump to the board row; no "type exact suits" at the rank-resolution
prompt (must retype `AhKd`); the awaiting banner does not auto-focus the
pending slot. Cosmetic input-speed gaps; no correctness or visibility effect.

## KG-8 — TAXONOMY minor scoping/labelling — LOW
- ALLIN_FAVORITE/UNDERDOG/FLIP fire heads-up only (multiway all-ins out of v1,
  documented in code).
- COLD_CALL_3BET excludes blind players (defensible "voluntary money" reading,
  slightly stricter than literal).
- Seat label `LJ` in the spec is `MP` in code/charts (internally consistent;
  detection unaffected).
- `vocabulary.js` claims analyzers import it; they don't — they emit matching
  hardcoded strings. Matches today, but nothing enforces it.
**Fix direction (optional):** import the vocabulary constants into the
analyzers to make drift impossible; align the `LJ`/`MP` label.

## KG-9 — Break/redraw fire under disabled auto-balance — LOW (TOURNAMENTS §4)
With per-tournament auto-balance OFF ("pure manual mode"), table-breaking and
the final-table redraw still run automatically (they are structural, not
balancing). A strict reading of "pure manual mode" might expect them
suppressed too. Defensible as-is; noted for truthfulness.

---

**Status:** none of the above is a data-integrity or money-correctness defect
(those were all fixed in M8.6). They are feature deferrals, content, a cost
decision, and cosmetic/edge items — safe to carry into production with eyes
open.
