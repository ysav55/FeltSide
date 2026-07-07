# M8 — Production Hardening & Handoff: Summary

**The deliverable of M8 is trust, in writing.** Every scope item is complete;
this page is the index. All suites green: **FeltSide server 192, client 20;
EpokerCRM connector 8**. No feature was added — M8 hardened only.

| # | Scope | Outcome | Evidence |
|---|-------|---------|----------|
| 1 | Legacy retirement | `legacy/` deleted; `git grep -i legacy` is docs-only; PRD §9 closed in past tense | decisions/0012 |
| 2 | Load & soak | 6 mixed tables, 32 actors, 46 min: 0 invariant violations, closed economy exact, peak RSS 216 MB / 512 MB, p95 251 ms | ops/M8-load-soak.md |
| 3 | Crash drills | 5 kill scenarios (showdown, awaiting_deal, level change, export walk, sync reconcile): recovery + ledger + export hold, live `kill -9` + in-process regression | ops/M8-crash-drills.md, test/crashDrills.test.js |
| 4 | Security pass | auth rate limiting (429 + Retry-After), key endpoints reject non-key with no oracle, deps 0-vuln (vitest 2→4 cleared 5 dev CVEs), structured secret-scrubbing logger, JWT expiry/re-auth, key-rotation procedure | ops/M8-security.md |
| 5 | Operations | backup/restore **drilled** (row counts + bankroll fingerprint + ledger all matched), Fly health check + crash-loop alerting, structured logs + tail commands, phone-readable runbook | ops/M8-operations.md, RUNBOOK.md |
| 6 | Conformance audit | PRD + 5 specs walked section by section; **1 HIGH + 4 MEDIUM fixed with tests**, 9 known-gaps logged; constitution ends truthful | ops/M8-conformance-audit.md, decisions/0013 |
| 7 | Grand E2E | live engine⇄CRM evening through the real connector: finish positions, tags, revision re-emit, zero duplicates, no schema drift | ops/M8-grand-e2e.md (log in the CRM repo) |

## The bugs M8 caught and fixed

Hardening earned its keep — the audit and soak found real defects that the
happy-path milestone tests missed:

- **HIGH — mid-hand snapshot chip loss (RUNTIME §1).** `snapshotSeats()` wrote
  reduced live stacks; a persist firing mid-hand (the tournament 30 s tick, or
  a cash join/rebuy/sit-out) meant a crash voided the hand *without returning
  the committed chips*. The crash drills missed it because they all crash
  between hands. Fixed: the snapshot now holds hand-start stacks while a hand
  runs. Regression test added.
- **MEDIUM — export ordering under concurrency (CONTRACT §3).**
  `recordingRepo` ran `begin`/advisory-lock/`commit` as separate pool queries
  that could span different connections. Fixed: one pinned client per
  transaction.
- **MEDIUM — empty-page cursor (CONTRACT §3).** A caught-up poll returned
  `next_cursor: null`, making a naive CRM re-pull from the start each tick.
  Fixed: echo the cursor.
- **MEDIUM — dealing duplicate guard (DEALING §1.3).** Editing one card of a
  two-card hole slot falsely reported a duplicate. Fixed.
- **MEDIUM — retroactive tournament settings (TAXONOMY §6).** Tournament hands
  snapshotted analyzer settings at completion, not deal time. Fixed.

## Known gaps carried into production (decisions/0013)

None are data-integrity or money defects — those were all fixed. The remainder
are features the spec lists that M8 (which adds none) deferred, one Fly
always-on cost decision for Jo, and a handful of low-impact edge/ergonomic
items. All documented so the specs and code no longer silently disagree.

## Bottom line for Jo

The engine survives crashes without losing a chip, holds its ledger and export
guarantees under real load, rejects abuse, has a drilled backup/restore and a
phone-readable runbook, matches its own constitution (with every gap either
fixed or written down), and demonstrably integrates with the CRM end to end.
Ship it.
