# 0011 — M7: Tournaments — choices, verification vectors, discovered issues

## Preset & structure choices (TOURNAMENTS §1-2, gaps left to implementation)

- **Add-on price = one buy-in** (§1 defines the add-on's chips but not its
  price; the preset carries `addon.cost`, defaulting to `buy_in` — standard
  live practice).
- **BB ante size = one BB** (modern live standard), stored per ladder row so
  the coach can edit it.
- **Blind ladders round the BB to double the chip step** so `sb = bb/2` is
  always a whole chip. First implementation produced `275/137.5` — the
  fractional amounts overflowed into stacks and broke `bigint` recording
  columns. Chips are integers, end to end.
- **Re-entry max**: seeded presets allow 2 re-entries; window per §1.

## Lifecycle & scheduling

- **scheduled → registering** is coach-initiated (`POST /tables/:id/open`,
  same surface as lessons) **plus** an autonomous backstop: CRM-pushed
  tournaments with a preset open on their own once inside a 1-hour window
  before `scheduled_start` (checked at boot and hourly). §3 specifies
  auto-START but is silent on auto-OPEN; autonomous-by-default decided it.
- **Tournament config is snapshotted** onto the `tournaments` row at
  activation: editing a preset never shifts a live or scheduled-and-opened
  tournament (verified by test).
- **Cancelling during registration refunds every chip** (closed economy —
  the pool must go somewhere, and nothing was played).
- Edge accepted for v1: if the LAST elimination happens while the busted
  player's re-entry window is still open, the tournament completes
  immediately rather than waiting for a re-entry decision.

## Engine mechanics

- **Dead-button rules** live in `TableEngine` behind `config.tournamentBlinds`:
  the BB advances one occupied seat per hand; SB = the seat that just held
  the BB (dead when empty); button = the seat that just held the SB (may be
  an empty seat). Heads-up: button is SB.
- **Busts apply synchronously at `hand_complete`.** The first implementation
  processed eliminations on each table's async chain; boundary work at
  OTHER tables could observe stack-0 "zombies" as live players — and the
  balancer once moved two of them across tables, corrupting the structure
  (final table never formed). Elimination + unseat + re-entry-window
  bookkeeping is now synchronous with the engine event; only recording and
  balancing stay on the chain.
- **The level clock burns real elapsed time**, not tick counts. Under load
  the 1s interval fires late; a count-based clock silently froze (observed:
  1% of real time under a busy event loop). Pause/break time is discarded.
- **A hand-recording failure never kills a table's game loop** — the error
  is logged and the tournament plays on (recording is not the game).

## Balancing / breaking / hand-for-hand (§3-4)

- Balance moves only take a player from a table that is **between hands**
  (the mover may be in a live hand otherwise); the destination may be
  mid-hand — the mover simply joins its next hand. Deferred work re-runs at
  every hand boundary.
- While a break/final-redraw is due, new hand starts are held tournament-wide
  so the structure change happens at the earliest boundary where the
  affected tables are idle.
- Hand-for-hand engages exactly when `live == paid_places + 1` and holds
  every table until all are idle, then releases starts together.

## Payouts & ICM (§5, §7) — verification vectors

`computePayouts` splits per the §5 table, floors each place, remainder to
first — sums to the pool exactly (property-tested over odd pools/fields).

Malmuth-Harville ICM (`icmEquities`) verified against hand-derived exact
vectors (in `test/tournament/icm.test.js`):

| Stacks | Payouts | Expected $EV |
|---|---|---|
| 5000/3000/2000 | 50/30/20 | 38.392857 / 32.75 / 28.857143 |
| 9000/500/500 | 65/35 | 61.815789 / 19.092105 / 19.092105 |
| 7500/2500 (HU) | 65/35 | 57.5 / 42.5 |
| equal ×4 | any | equal shares |
| any, 1 payout | 100 | chip-proportional |

Plus structural properties: zero stack → zero equity, monotone in stack,
big-stack equity strictly below chip-proportional share, Σ = pool.
`icmDeal` floors to whole chips, remainder to the chip leader.

Deal semantics: live players take ICM amounts; already-eliminated ITM
finishers keep their standard-table amounts; the payout total still equals
the pool to the chip.

## Export (CONTRACT §4.3, §4.7)

- `finish_position` joins through `sessions.table_id → tournaments →
  tournament_entries`; null for non-tournament sessions (exact §4.3 shape,
  no new fields added).
- §4.7 tournament-preset catalog is real (id/name/description/updated_at).
- `engine_version` bumped to 0.7.0.

## Discovered issue (pre-existing, NOT fixed in M7 — flagging for Jo)

**`recordingRepo` transactions are not connection-pinned.** `recordHand`,
`finalizeSession` and `bumpRevision` issue `begin` / `pg_advisory_xact_lock`
/ `commit` as separate `db.query` calls. On the production `pg.Pool`, each
call can check out a **different** connection, so the transaction and the
advisory lock do not actually span the statements — the CONTRACT §3
"seq assignment order == commit order" guarantee is not enforced in prod
(it holds on PGlite/tests, which are single-connection). Concurrent
tournament tables made the interleaving visible. Fix direction: check out a
single client (`pool.connect()`) per transaction. Filed as a follow-up —
core plumbing shared by M3-M6 paths, deliberately not touched inside M7.

Same family, lower severity: `tablesRepo.deleteScheduled`,
`scenariosRepo.remove`, `playlistsRepo.remove` still read `rowCount` only
(PGlite returns `affectedRows`) — flagged in M6, still open.
