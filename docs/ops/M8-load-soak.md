# M8.2 — Load & Soak Report

**Verdict: PASS.** 46 minutes at target scale, zero invariant violations,
memory well within the 512 MB Fly instance, no server-side errors.

## What ran

A real server process (`node src/index.js`) against real PostgreSQL 16,
driven by `server/tools/soak.mjs` — 32 scripted actors connected over
socket.io exactly as the client does. Six concurrent tables at once:

| Table | Mode | Actors |
|-------|------|--------|
| Soak Cup | tournament (Lesson Turbo, 18 entrants → up to 3 internal tables) | 18 bots + coach |
| Soak lesson | coached cash (coach deals RNG hands continuously) | 4 students + coach |
| Soak cash 1 | uncoached cash, 50/100 | 5 bots (re-buy on bust) |
| Soak cash 2 | uncoached cash, 50/100 | 5 bots (re-buy on bust) |

Tournament bots re-entered while the window was open (31 re-entries over the
run); cash bots re-bought on bust to keep tables live for the full soak.

Reproduce:
```
# start Postgres, create DB, migrate, boot server on :3999
SOAK_URL=http://127.0.0.1:3999 SOAK_DB=postgres://…/feltside_soak \
  SOAK_MINUTES=46 SOAK_SERVER_PID=<server pid> EXPORT_API_KEY=… \
  COACH_EMAIL=… COACH_INITIAL_PASSWORD=… \
  node tools/soak.mjs > soak-run.ndjson
```
Raw run: `soak-run.ndjson` (NDJSON, one event per line; ticks every 10 s,
ledger invariant every 5 min, full REPORT at the end).

## Results (46-minute run)

| Metric | Value |
|--------|-------|
| Actors | 32 |
| Actions sent | 23,194 |
| Hands recorded | 1,466 |
| Hands exported | 1,466 (8 cursor pages, **no duplicate `(hand_id, revision)`**) |
| Action latency p50 | **1.6 ms** |
| Action latency p95 | 251 ms (cumulative); windowed peak ~650 ms during the busiest phase, then settled |
| Action latency p99 | 643 ms |
| Action latency max | 1,425 ms |
| RSS start / peak / end | 118 / **216** / 129 MB |
| Ledger invariant (every 5 min + final) | **10/10 OK** |
| Closed economy (final) | **exact: 32,000,000 chips in → 32,000,000 out, 0 stranded** |
| Server-side errors / crashes / unhandled rejections | **0** |

### Action "errors" — explained

The harness counted 458 action rejections (excluding the benign
`not_your_turn`). A targeted instrumented run categorized them: **100 % were
`invalid_raise_size`**. Cause: a scripted bot computes its raise amount from
the socket state it last received; under load that state can be one push
behind, so by the time the action reaches the server the minimum raise has
moved and the engine correctly rejects the now-illegal amount. This is input
validation working, not a fault — a real client recomputes legal actions from
the latest state push and never sends the stale amount. No rejection ever
corrupted a hand, and the closed-economy total is exact to the chip.

### Latency note

p50 is ~1.6 ms — the serialized per-table mutation queue is not a
bottleneck at this scale. The p95/p99 tail (and the ~650 ms windowed peak in
the first ~10 minutes) coincides with the tournament's early phase: three
internal tables plus two cash tables plus a coached table all active while
re-entries fire and the balancer moves players. It decays as the field
consolidates. For a coaching tool with human-paced action (a player takes
seconds to act), sub-second acknowledgement under the worst burst is
comfortable headroom.

## Memory & sizing

Peak RSS **216 MB** against the **512 MB** instance — 42 % utilization at a
load (6 tables, 32 actors) at the very top of the stated target (up to 6
concurrent tables, ~50 players). GC visibly reclaimed to ~106–130 MB
mid-run; no upward drift over 46 minutes (no leak).

**Recommendation: 512 MB is sufficient for the target scale, with ~2×
headroom.** No resize needed. If Jo ever pushes materially past the stated
ceiling (e.g. multiple large tournaments simultaneously), revisit at that
point — but nothing in this run suggests it is near a limit.

## Invariants verified continuously

- **Ledger:** `balance == Σ(transactions)` for every account, and no
  negative balances — checked at t+5,10,…,45 min and at final. Held every
  time.
- **Closed economy:** after quiescing (tournament ended-early, cash players
  cashed out, tables closed), the sum of all player balances plus any chips
  still on an open table equalled the total coach funding, to the chip.
- **Export at-least-once, no skip/dup:** every recorded hand appeared exactly
  once in a full cursor walk of `/export/v1/hands`; recorded count ==
  exported count.
