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
| ~~server/game/ReplayEngine.js~~ | **REBUILT in M6, not graduated** — the legacy module's architecture *was* ARCH-05 (mutate-by-reference + unbounded deep-copy on branch) and it was welded to the old GameManager state shape. Removed from `legacy/`; replaced by a pure immutable frame model in `server/src/game/ReplayEngine.js`. See docs/decisions/0010. |
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

---

## Amendment (M2 Step 0.2 — see docs/decisions/0004)

Verified against the old repo's full git history (38 commits): five listed
files never existed under any name. Reality:

| Manifest entry | Outcome |
|----------------|---------|
| server/game/BoardGenerator.js | Never existed. Texture logic lives inside HandGenerator.js → extracted to `legacy/extracted/boardTexture.js` |
| server/game/EquityService.js | Never existed; NO equity computation anywhere in the old repo. M5's ALLIN_* tags need a new implementation |
| client/src/utils/comboUtils.js | Never existed. Combo expansion/intersection lives in HandConfigPanel.jsx → extracted to `legacy/extracted/RangePresetPicker.jsx` |
| client/src/components/RangeMatrix.jsx | Never existed. The old range UI is a preset-chip picker (no 13×13 matrix) → same extraction |
| client/src/components/RangePicker.jsx | Never existed (CardPicker.jsx is a single-card picker, not a range picker) → same extraction |

`legacy/extracted/` holds raw material, not working modules. The M4 range
matrix and M5 equity service must be built new.
