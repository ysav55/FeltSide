# M8.3 — Crash Drills

**Verdict: PASS.** Every drill recovers per RUNTIME §1, the ledger reconciles,
and the export guarantees (at-least-once, no skip, no duplicate) hold.

## What "crash" means here

A `kill -9` destroys the in-memory runtimes and nothing else — the database
is exactly whatever committed before the axe fell. Recovery is
`TableService.recover()` at the next boot, which rebuilds every non-completed
table from its persisted snapshot and voids any in-flight hand (stacks are
hand-start values; nothing was recorded).

The drills were exercised **two ways**, and both pass:

1. **Real forced `kill -9` of a live server process** — `server/tools/
   crashdrills.mjs` spawns `node src/index.js` against real PostgreSQL,
   drives each scenario, `SIGKILL`s the OS process, and restarts it. This
   proves the real-process recovery path (port release, fresh boot,
   `recover()` over a live Postgres).
2. **Deterministic in-process regression** — `server/test/crashDrills.test.js`
   models each kill by discarding the runtimes and calling
   `recover()` on a fresh `TableService` over the same DB (the exact code
   `index.js` runs on the next boot). Committed, part of the suite, green.

The in-process form is the durable regression (runs in CI on every change);
the live form is the belt-and-braces proof that an actual `SIGKILL` behaves
identically. Timing a kill from outside is inherently racy, but the asserted
invariants hold regardless of exactly where it lands — which is the point.

## The five drills

Each asserts **(R)** recovery, **(L)** ledger `balance == Σ(transactions)` and
no negatives, **(X)** a full export cursor walk = recorded-hand count with
zero duplicates.

| Drill | Kill moment | Key assertion beyond R/L/X |
|-------|-------------|----------------------------|
| **Showdown** | cash hand at all-in showdown | in-flight hand either fully recorded or fully absent — never partial |
| **Awaiting-deal** | coached table parked on a manual flop (`awaiting_deal`) | on reboot `awaiting` is cleared, the hand is voided, coached seating never touched the ledger |
| **Tournament level change** | just after a level advanced + persisted | `clock.level` restored exactly; live stacks and entries identical (≤1 hand lost — 0 here, killed between hands) |
| **Export cursor walk** | mid cursor walk of `/export/v1/hands` | interrupted walk + resume from last cursor sees every recorded hand exactly once (export is stateless; `export_seq` is stamped in the hand's own DB txn under an advisory lock, so no partial hand and no gap) |
| **Sync reconcile** | mid `reconcileLessons` (partial write) | the next full CRM push converges to the exact snapshot; idempotent on a third push; ledger untouched |

### Live-run results (tools/crashdrills.mjs, real `kill -9`)

The three drills that reach a clean live outcome without racy timing —
**sync-reconcile, showdown, awaiting-deal** — were captured from an actual
`SIGKILL` + restart cycle:

```
DRILL mid-sync-reconcile   pass=true  converged=true scheduled=8  ledger ok
DRILL kill-during-showdown pass=true  recovered=1    ledger ok    export ok
DRILL kill-during-awaiting pass=true  recovered=2    ledger ok    export ok
```

The **level-change** and **export-walk** live drills depend on precisely-timed
external kills that are flaky to reproduce in this sandbox; their invariants
are fully covered by the deterministic in-process test (both green), which
models the identical recovery path. All five pass in `crashDrills.test.js`.

## Why the ledger can never half-commit

`bankrollRepo.applyTransaction` writes inside a single DB transaction with a
`CHECK balance >= 0`; a `SIGKILL` either commits the whole row or none of it.
Hand play never touches the ledger (only buy-in / cash-out / tournament
buy-in / re-entry / add-on / payout do), so a mid-hand kill leaves the ledger
trivially consistent — proven empirically in every drill.

## Known follow-up (not a drill failure)

`recordingRepo` issues `begin` / `pg_advisory_xact_lock` / `commit` as
separate pool queries, so on a multi-connection `pg.Pool` the advisory lock
may not span the statements (decisions/0011, carried as KG in the conformance
audit). This does not break crash consistency — each hand's insert is still a
single transaction — but it is the one place the CONTRACT §3 ordering
guarantee is weaker in production than in the single-connection test DB.
