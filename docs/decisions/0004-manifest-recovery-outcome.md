# 0004 — Manifest recovery: the five missing files never existed

**Context:** M2 Step 0.2 ordered a git-history search of the old
poker-trainer repo for the five files missing at M1 import
(decisions/0002).

**Search performed:** filename search over `git log --all --name-only`
(all 38 commits), plus content searches across every historical blob for
`handGroupToCombos`, `poker-odds-calculator`, `calculateEquity`,
`monte carlo`, `equity`, `13x13`, `hand matrix`, `range grid`,
`EQUITY` tag emission, and all-in/favorite/underdog analyzer code.

**Findings:**
- None of the five files ever existed in history under any name.
- The only "equity" hits in history are documentation (BATCH_TESTING.md,
  DOCS.html). **The old repo contains no equity computation at all** — the
  old EQUITY_* tags (TAXONOMY §7) evidently never shipped an implementation.
- The old range UI is a preset-chip picker inside HandConfigPanel.jsx
  (no 13×13 matrix anywhere); combo intersection logic lives there too.
- Board texture logic lives inside HandGenerator.js.

**Actions taken (Step 0.2c):**
- `legacy/extracted/boardTexture.js` — texture classification/validation
  lifted from HandGenerator.js (BoardGenerator stand-in).
- `legacy/extracted/RangePresetPicker.jsx` — preset vocabulary +
  combo-intersection data layer lifted from HandConfigPanel.jsx
  (RangeMatrix/RangePicker/comboUtils stand-in).
- LEGACY_MANIFEST.md amended with the outcome table.

**Consequences:** The M4 range-matrix editor and the M5 equity service
(ALLIN_FAVORITE/UNDERDOG/FLIP thresholds) must be built new; nothing to
graduate. Flagged for planning.
