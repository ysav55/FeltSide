# 0009 — M4/M5 implementation choices

Interpretive calls inside the specs' stated freedom, plus deviations.

1. **Chart position naming: engine vocabulary wins.** positions.js calls
   TAXONOMY §4's `LJ` seat `MP` (same seat, 7–9 handed). Chart keys use
   the engine names (`UTG, UTG+1, UTG+2, MP, HJ, CO, BTN, SB`) so no
   translation layer exists between recorded positions and charts.

2. **Chart seeds are standard published-range approximations.** Live
   sources were unreachable from this build environment (M5 prompt
   explicitly allows this, said loudly): the seeded opens/defends follow
   the conventional tight-early → wide-late shapes every modern training
   chart teaches. Every chart is coach-editable with per-chart reset; the
   seeds are starting points, not claims of GTO authority.

3. **`forceStreet` is chip-safe by refusal.** It auto-checks every live
   player only when nothing is owed; facing an unmatched bet it errors
   (`bets_unmatched`) instead of folding players by fiat — chip
   conservation is asserted in tests after every control.

4. **Undo = snapshot stack; rollback = street re-deal.** Every voluntary
   action pushes a full engine snapshot; undo pops one and MARKS the
   undone actions (`reverted`, kept in the log, persisted, exported as an
   additive field per CONTRACT §6). Street rollback restores the pre-deal
   snapshot, releases the street's cards to the source, and re-runs the
   deal — the coach may stage different cards first; betting on the
   rolled-back street is marked reverted. Counters and analyzers ignore
   reverted actions. Both set the `UNDO_USED` descriptor.

5. **awaiting_deal must not deadlock the runtime chain.** A player action
   that closes a betting round onto a manual street parks inside the
   serialized queue awaiting the coach. `provide`/`rng-rest` therefore
   bypass the queue (they are what resolves it), and awaiting-guards on
   the other controls run before enqueueing.

6. **Panel-claimed cards are blocked for RNG.** Typed hole cards and
   staged board slots are excluded from every random draw (live check),
   so pre-staging a river card survives all earlier fills (§3).

7. **ALLIN_* equity fires only on exactly-two-live all-ins.** Multiway
   all-in equity is ambiguous evidence; out of v1 (TAXONOMY §2 describes
   the two-player moment).

8. **Analyzer settings snapshot at DEAL time** — §6 "future hands only"
   read strictly: a mid-hand settings change does not affect the hand in
   flight (tested).

9. **tag_vocabulary_version stays 1.** M5 implements exactly the
   TAXONOMY v1 vocabulary the M3 meta endpoint already published — no
   drift, no bump. `engine_version` moves to 0.5.0.

10. **Coach spectate = `table:observe`** (socket): coach-gated room join
    without a seat; coach payloads (`coach_state`) are emitted only to
    sockets whose JWT carries the coach role — visibility rules live
    server-side in the runtime + socket layer, never in the client.
