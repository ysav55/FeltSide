# 0012 — M8: legacy/ retired — final disposition of every remaining file

`legacy/` is deleted. No code under `server/` or `client/` imports from it
(verified: `git grep` hits are docs and graduation comments only). Final
disposition of the eight files that remained after M7:

| File | Disposition | Why it was never needed (or where it went) |
|------|-------------|--------------------------------------------|
| `game/RangeParser.js` | **Graduated** (M4/M5) | Lives at `server/src/game/RangeParser.js` with its own suite (`test/game/rangeParser.test.js`); graduation fixes documented in the module header. The legacy original should have been removed at graduation — housekeeping miss, corrected now. |
| `game/HandGenerator.js` | **Deleted — superseded** | Its fill-the-gaps role (partial holes/board + range constraints + RNG fill) is served by the M4 `coachedCardSource` (DEALING §1.4), built new and tested. Its `board_texture` constraint feature exists in no binding spec — DEALING.md never asks for texture-constrained generation. The ARCH-10 graduation gate was therefore never exercised. |
| `client/rangeParser.js` | **Deleted — superseded** | Client range needs (matrix ⇄ notation) are served by `client/src/utils/ranges.js`, built new in M4. |
| `client/PokerTable.jsx` | **Deleted — audit verdict was rebuild** | decisions/0005: the table UI was rebuilt lean in M2/M4. Audit-before-adoption concluded against adoption. |
| `client/BettingControls.jsx` | **Deleted — audit verdict was rebuild** | Same as PokerTable (decisions/0005). |
| `extracted/boardTexture.js` | **Deleted — raw material, role ended** | Extracted in M2 recovery (decisions/0004) as *reference only*. Nothing in the binding specs requires board-texture constraints; nothing was built from it. |
| `extracted/RangePresetPicker.jsx` | **Deleted — raw material, role ended** | Reference for the M4 range matrix, which was built new (decisions/0004, 0009). |
| `LEGACY_MANIFEST.md` | **Deleted with the folder** | Its history (including the M2 amendment about the five never-existed files) is preserved in git and summarized in PRD §9's closing ledger. |

Previously departed: `game/HandEvaluator.js`, `ShowdownResolver.js`,
`SidePotCalculator.js`, `bettingRound.js`, `Deck.js`, `positions.js`
(graduated M2 with new suites); `game/ReplayEngine.js` (rejected and
rebuilt in M6 — decisions/0010).

PRD §9 rewritten to past tense as the closing ledger of the reuse program.
