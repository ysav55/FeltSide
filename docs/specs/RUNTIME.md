# RUNTIME.md — Table Lifecycle, Recovery & Bankroll Ledger (v1)

> Resolves PRD_SKELETON §11.4–11.5. Governs what happens when players
> disconnect, servers crash, tables idle, and chips move in and out of play.

---

## 1. Persistence posture (the governing decision)

Live game state is in-memory; the database holds **safety snapshots**:

- **Stacks are persisted after every completed hand** (already required for
  hand recording — `stack_end` per participant).
- **Tournament clock state** (current level, ms remaining) is persisted on
  every level change and every 30s tick.
- **A hand in flight is never recoverable.** On crash/restart it is
  **voided**: all bets returned, stacks restored to hand-start values,
  nothing exported. Rationale: replaying a half-finished hand from an
  action log across reconnecting clients is enormous complexity for a
  practice platform; a voided hand costs nothing real.

**Recovery on boot:** rebuild every non-completed table from its last
snapshot (seats, stacks, tournament clock), void any in-flight hand, resume.
A live tournament survives a server restart losing at most one hand and a
few clock seconds.

**Fly scale-to-zero guard:** the idle shutdown timer may fire ONLY when zero
tables are active. An active tournament or seated cash table pins the
machine awake. (Export API cold starts remain fine per CONTRACT §2.)

## 2. Disconnect & reconnect (per mode)

| Mode | On disconnect | Seat retention | Timeout outcome |
|------|--------------|----------------|-----------------|
| Coached | Nothing automatic — the coach owns the room. Player shown as disconnected; coach may pause or play on | Until coach removes or session ends | Coach's call |
| Uncoached cash | 60s grace (current hand plays on its timer), then auto sit-out | 5 min sat-out, then auto cash-out to bankroll | Stack safely banked |
| Tournament | Per TOURNAMENTS §8: blinds/antes post, timer auto-folds | Always — a tournament seat is never vacated | Blinds out naturally |

Reconnection within retention: same seat, same stack, live state pushed on
join. All reconnect identity is by player account (JWT), never socket id.

## 3. Table cleanup

- **Uncoached cash:** zero connected players for 10 min → close table,
  cash out all remaining stacks to bankrolls.
- **Coached:** closed by the coach ("end session"); auto-closed 60 min
  after `scheduled_end` if empty. Closing exports the session.
- **Scheduled, never started:** removed by the next CRM sync reconcile
  (CONTRACT §8) or 24h after scheduled start, whichever first.
- **Tournament:** exists until `completed`; only the coach's End Early can
  short-circuit (TOURNAMENTS §6).
- Closing any table finalizes and exports its session (CONTRACT §4.3) —
  sessions only ever export complete.

## 4. Action timers

- Uncoached cash: 30s per decision, auto check/fold on expiry (configurable
  per table at creation).
- Coached: **no timer by default** — the coach paces the room; optional
  per-table timer if he wants pressure drills.
- Tournament: per preset (`action_timer_sec`).
- Timers suspend during `awaiting_deal` (DEALING §3) and coach pause.

## 5. Bankroll ledger

Adopts the one proven pattern from the old chip bank: **immutable
transaction log + derived balance, written atomically**.

```python
bankroll_account = {"player_id": str, "balance": int}  # CHECK balance >= 0

bankroll_transaction = {           # append-only, never updated or deleted
  "id": str, "player_id": str,
  "type": "coach_adjustment | buy_in | cash_out | tournament_buy_in |"
          " tournament_reentry | tournament_addon | tournament_payout",
  "amount": int,                   # signed
  "ref_id": str | None,            # table / tournament id
  "note": str | None,              # coach_adjustment reason
  "balance_after": int,
  "created_at": str,
}
```

- Balance update + transaction insert are one DB transaction; the invariant
  `balance == sum(transactions)` is auditable at any time.
- **Scope (locked):** bankroll touches uncoached cash and tournaments only.
  Coached tables never read or write it — lesson stacks are coach-set play
  chips.
- **Flow:** debit at buy-in (seat taken / registration), credit at cash-out
  (leave, table close, auto cash-out) and tournament payout. In-flight
  chips live only in game state; §1's snapshot discipline guarantees a
  crash cashes out from the last completed hand.
- **Insufficient balance** blocks a buy-in — but the coach can grant an
  adjustment on the spot (the standing soft-limit philosophy).
- **Coach reset/reload:** a `coach_adjustment` with a note; "reset to X" is
  computed as a delta so the log stays append-only.
- **Not exported to the CRM.** Bankroll is practice currency, not
  performance data; per-session `net_chips` (already in CONTRACT §4.3)
  covers the analytical need.
