# LEGACY_MANIFEST.md — the ONLY files allowed in from the old repo

Source: the old poker-trainer repository (local on this machine — ask Jo
for the path only if you cannot locate it). Copy each file below into this
`legacy/` folder, preserving the sub-structure shown. Paths are as
documented in the old repo's ARCHITECTURE.md — if a path moved, find the
module by name and note the correction in docs/decisions/.

## Adopt list (PRD §9 — pure modules)

| Old path | Destination |
|----------|-------------|
| server/game/HandEvaluator.js | legacy/game/HandEvaluator.js |
| server/game/ShowdownResolver.js | legacy/game/ShowdownResolver.js |
| server/game/SidePotCalculator.js | legacy/game/SidePotCalculator.js |
| server/game/bettingRound.js | legacy/game/bettingRound.js |
| server/game/Deck.js | legacy/game/Deck.js |
| server/game/RangeParser.js | legacy/game/RangeParser.js |
| server/game/positions.js | legacy/game/positions.js |
| server/game/BoardGenerator.js | legacy/game/BoardGenerator.js |
| server/game/EquityService.js | legacy/game/EquityService.js |
| server/game/HandGenerator.js | legacy/game/HandGenerator.js  ⚠ ARCH-10 |
| client/src/utils/comboUtils.js | legacy/client/comboUtils.js |
| client/src/utils/rangeParser.js | legacy/client/rangeParser.js |

⚠ HandGenerator may only graduate with ARCH-10 fixed: the silent
100-attempt texture fallback must become a visible coach-facing error.

## Must-carry gold (UI — audit on graduation, but always carried)

| Old path | Destination |
|----------|-------------|
| client/src/components/RangeMatrix.jsx | legacy/client/RangeMatrix.jsx |
| client/src/components/RangePicker.jsx | legacy/client/RangePicker.jsx |

## Audit-before-adoption (copy now, graduate ONLY after explicit review)

| Old path | Destination |
|----------|-------------|
| server/game/ReplayEngine.js | legacy/game/ReplayEngine.js  ⚠ ARCH-05 |
| client/src/components/PokerTable.jsx | legacy/client/PokerTable.jsx |
| client/src/components/BettingControls.jsx | legacy/client/BettingControls.jsx |

## Rules

1. Copy ONLY the files above. No other file from the old repo may be read
   for implementation purposes, referenced, or imitated.
2. Every module graduates out of legacy/ by: (a) new test suite written
   against docs/ (never against old behavior), (b) zero imports from
   anything outside the new tree, (c) all registered findings on it fixed.
3. Graduated files are MOVED (not copied) to server/ or client/; this
   folder must be empty and deleted by the end of M7.
