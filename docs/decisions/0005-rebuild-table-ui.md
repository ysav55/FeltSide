# 0005 — PokerTable.jsx / BettingControls.jsx: rebuild, not graduate

**Context:** M2 §5 requires an explicit audit of the two audit-listed
legacy client components against the PRD §9 bar.

**Audit findings:**
- `PokerTable.jsx` imports five modules that are NOT on the manifest
  (PlayerSeat, GhostSeat, WatcherIndicator, BoardCards, utils/chips) —
  graduating it would smuggle unvetted code past the customs zone.
- Both are wired to the old socket protocol's `gameState`/`emit` shape,
  which the lean rebuild deliberately replaces.
- Both are saturated with out-of-M2 concerns: replay-mode controls and
  branch UI (M6), coach shadow-acting (M4/M6), watcher indicators
  (spectating — explicitly out), pause states.

**Decision:** Rebuild the table UI lean for M2 (seats, board, pot,
betting controls, timer, sit-out, leave). The two legacy files stay in
`legacy/` as visual/UX reference for M6's replay UI, then graduate or
delete per the M6 audit.

**Justification:** Fails the "zero imports from outside the new tree"
bar outright; the salvageable part (seat layout geometry) was
re-derived in minutes.
