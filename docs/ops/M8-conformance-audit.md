# M8.6 — Conformance Audit (PRD + 5 specs vs. code)

**Verdict: the constitution is truthful.** Every binding document (PRD +
CONTRACT, DEALING, RUNTIME, TAXONOMY, TOURNAMENTS) was walked section by
section against the implementation. The audit found **1 HIGH, 5 MEDIUM, and
several LOW** deviations. All HIGH and the correctness-affecting MEDIUMs were
**fixed with tests**; the remainder are logged as numbered known-gaps in
`docs/decisions/0013-known-gaps.md` with severity and rationale.

Method: five independent per-spec audits (one reader per spec) plus a PRD
pass, each producing section-by-section findings with `file:line` citations.
Full server suite after fixes: **192 green**.

## Fixed in M8.6

| # | Spec | Severity | Finding | Fix |
|---|------|----------|---------|-----|
| 1 | RUNTIME §1 | **HIGH** | `snapshotSeats()` wrote *reduced live* stacks; a persist firing mid-hand (cash join/rebuy/sit-out, or the tournament 30s clock tick) meant a crash voided the hand **without returning committed chips** — real chip loss / stack corruption. The crash drills missed it because they all crash *between* hands. | `snapshotSeats()` now emits hand-**start** stacks while a hand is running (`handStartStacks`), so every persist path is crash-safe. Regression test: `crashDrills.test.js` → "MID-HAND persist does not lose committed chips". |
| 2 | CONTRACT §3 | MEDIUM | `recordingRepo` ran `begin`/`pg_advisory_xact_lock`/`commit` as separate `pool.query()` calls; on a `pg.Pool` they can hit **different connections**, so the lock/transaction don't span the statements and export_seq ordering could break under concurrent tables. (Flagged since decisions/0011.) | New `withTx()` pins one client per transaction on `pg.Pool`; PGlite (single-connection) path unchanged. Applied to `recordHand`/`finalizeSession`/`bumpRevision`. |
| 3 | CONTRACT §3 | MEDIUM | Empty-page `next_cursor` was `null`; a caught-up poller storing it verbatim would forget its position and re-pull from the beginning each idle tick (wasteful, cold-start amplified). | Empty page now **echoes** the caller's cursor (`export.js` envelope). Test updated in `export.test.js` to assert the parked-cursor behavior. |
| 4 | DEALING §1.3 | MEDIUM | The duplicate-card guard compared against the slot **being edited**, so changing one card of a two-card hole (`Ah Kd` → `Ah Ks`) falsely reported a duplicate against its own stale `Ah`. | `_validateCard(card, except)` excludes the slot/board cell under edit; genuine cross-slot and same-slot-pair duplicates still rejected. Test: `coached.test.js` → "duplicate guard". |
| 5 | TAXONOMY §6 | MEDIUM | `TournamentRuntime` snapshotted analyzer settings at hand **completion**, not deal time — a mid-hand settings change judged that hand (retroactive), unlike cash/coached. | Settings now captured at deal time in `_pump` (`table.handSettings`) and used in `_afterHand`, matching the other runtimes. Misleading "snapshot at completion" comments corrected in `analyzers/index.js` and `analyzerSettings.js`. |

## Logged as known-gaps (decisions/0013)

Not fixed in M8 — each is either a **feature** the spec lists (M8 hardens, does
not extend), or needs a **product/cost decision** that is Jo's to make, or is a
low-impact ergonomic/edge item. All are documented truthfully so the specs and
code no longer silently disagree.

- **KG-1 (MEDIUM, RUNTIME §1)** — no application-level scale-to-zero "pin
  awake" guard; an active tournament with all players disconnected relies on
  Fly's connection heuristic and can pause until someone reconnects (clock
  persists, so it resumes cleanly). Fixing properly = `min_machines_running=1`
  (pay for always-on) vs. accept pause-on-idle — Jo's call.
- **KG-2 (MEDIUM, TAXONOMY §4)** — seed charts are conventional
  approximations, not verified published ranges; coach-tunable. Affects
  chart-mistake tags until edited.
- **KG-3 (MEDIUM, DEALING §2)** — the dealing panel has no button/position
  control (a listed §2 capability). Feature, deferred.
- **KG-4 (MEDIUM, DEALING §3)** — no "RNG the rest of this **hand**" escape
  (only per-street). Feature, deferred.
- **KG-5 (LOW)** — `tablesRepo.deleteScheduled`, `scenariosRepo.remove`,
  `playlistsRepo.remove` read `rowCount` only (PGlite returns `affectedRows`);
  fine in prod, would misreport on PGlite. Carried from decisions/0011.
- **KG-6 (LOW, CONTRACT §8)** — the `{entries:[...]}` sync request wrapper is
  implemented on both sides but never written into CONTRACT §8. Doc gap.
- **KG-7 (LOW, DEALING §2)** — panel keyboard ergonomics: no `B`-to-board
  jump, no exact-suit entry at the rank-resolution prompt, awaiting slot not
  auto-focused.
- **KG-8 (LOW, TAXONOMY)** — ALLIN_* tags heads-up only; COLD_CALL_3BET
  excludes blinds; `LJ`→`MP` seat label; `vocabulary.js` overstates that
  analyzers import it (they emit matching strings but don't import). All
  currently-conforming or documented scoping choices.
- **KG-9 (LOW, TOURNAMENTS §4)** — with auto-balance disabled, table-breaking
  and final-table redraw still fire (structural necessity); a strict reading
  of "pure manual mode" might expect them suppressed.

## Sections confirmed CONFORMING (highlights)

- **CONTRACT** — every export shape (§4.1–4.7) exact; cursor at-least-once /
  no-skip / monotone / revision-re-emit; auth + `{code}` dialect; declarative
  never-touch-started lesson reconcile. Only the two MEDIUMs above (both fixed).
- **RUNTIME** — boot recovery, void-and-rebuild, disconnect/reconnect by
  account, cleanup/pruning, and the entire §5 bankroll ledger (immutable log,
  `balance == Σtx`, atomic apply with `balance>=0`, exact transaction-type set)
  conform. The HIGH (fixed) was the one integrity defect.
- **TOURNAMENTS** — all nine sections faithful; no HIGH/MEDIUM. Payout table,
  ICM vectors, dead-button, hand-for-hand, absence rules all match.
- **TAXONOMY** — all 37 vocabulary tags match analyzer output; descriptors,
  absolute + chart mistakes, counters, equity library, settings all conform.
- **DEALING** — the make-or-break visibility model (no hidden-card leak) is
  correctly server-enforced; awaiting_deal state machine, origin computation,
  re-deal/scenario tooling conform. Gaps were the F3 bug (fixed) + deferred
  panel features.
- **PRD** — §§1–12 describe the system as built; §9 (reuse) and §11 (build
  order) updated to past tense + M8 in M8.1. Truthful.
