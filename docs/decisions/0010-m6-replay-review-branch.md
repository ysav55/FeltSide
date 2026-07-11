# 0010 — M6: ReplayEngine rebuild, review, branch, group transition

## ReplayEngine — REBUILT, not graduated (PRD §9 verdict)

The legacy `legacy/game/ReplayEngine.js` was **rejected for adoption**:

1. Its architecture *is* ARCH-05. Every helper (`_applyAction`,
   `_buildStateAtCursor`, `branch`, `unbranch`, `exit`) mutated a shared
   `state` **by reference**; `branch()` did an unbounded
   `JSON.parse(JSON.stringify(state))` of the whole live game object, with a
   `>500KB` `console.warn` band-aid.
2. It was welded to the old GameManager shape (`state.replay_mode`,
   `stableId`, shadow players, `state.playlist_mode`, `is_observer`) — none
   of which exists in the new engine.

Replaced by `server/src/game/ReplayEngine.js`: a **pure, immutable frame
model**. `buildReplay(hand)` folds the non-reverted action log into a frozen
array of frames (one per action), reconstructing board/stacks/pot/currentBet/
toAct at each step. Nothing is mutated; the input hand is never touched;
memory is bounded by (#actions × #players). The 50-hand reconstruction
property test (`test/replayEngine.test.js`) proves it reproduces stored
`stack_end` and `pot`. Removed from `legacy/`; manifest updated.

## Review / retag / annotations

- **Detail is coach-only over HTTP** (`GET /api/hands/:id`) — it is
  open-kimono (all hole cards). Players only ever see a review through the
  coach-driven group-review socket path, never by calling the endpoint.
- **Annotations** (`hand_annotations`, migration 0007) are engine-side
  ONLY. Deliberately NOT exported: CONTRACT has no annotation field and we
  did not add one (M6 §3). Annotating does **not** bump the revision.
- **Retag** (add/remove coach tag, dismiss/restore auto tag) each bumps the
  revision via the existing `recordingRepo.bumpRevision`, which re-stamps
  `export_seq` so the hand re-enters the export stream exactly once
  (CONTRACT §4.5 — no guarantee weakened; the round-trip test asserts a
  single re-emit at the new revision). Dismissed tags carry a `dismissed`
  flag (migration 0007) and are filtered from the export; the row is kept
  for audit. Coach tags are deleted; auto tags are dismissed, never deleted.

## Branch-to-live (M6 §5)

`CoachedTableRuntime.branchFromHand(handDetail, cursor)`: present
participants keep their **reconstructed stacks-at-cursor** and recorded
cards, the board is pre-staged, and a fresh hand is dealt with a distinct
`originOverride: 'replay_branch'` on the panel (the 5th CONTRACT origin).
Analyzers fire on completion; bankroll is never touched (coached tables
don't). `unbranchFromHand()` restores the pre-branch stacks. Chip
conservation within the branch is the engine's existing guarantee, asserted
in the branch E2E.

- **Deviation (deadlock fix):** `branchFromHand` is deliberately NOT wrapped
  in the runtime's `_enqueue`, because it internally `await`s `this.deal()`
  which enqueues itself — a double-enqueue on the same chain deadlocks. The
  setup is synchronous; only the `deal()` it delegates to is serialized.

## Group transition (M6 §6)

Lives on the runtime (`groupReview` state) + socket fan-out
(`table:group_review` to the whole room). Coach-driven `review:enter /
review:nav / review:exit` broadcast the synced cursor + open-kimono payload
to every connected player at THAT table only — independence across parallel
tables is by construction (per-runtime state, per-room broadcast). Verified
with a two-table socket E2E.

## Smell surfaced (not fixed — separate issue)

PGlite (test DB) reports affected rows as `affectedRows`; node-postgres (prod)
as `rowCount`. The new `handReadRepo` deletes use `rowCount ?? affectedRows`
to work on both. The **older** repos (`tablesRepo.deleteScheduled`,
`scenariosRepo.remove`, `playlistsRepo.remove`) still read `rowCount` only —
they work in prod (pg) but a delete under PGlite tests would misreport. Worth
a small sweep to the same idiom; flagged for Jo, not touched here.
