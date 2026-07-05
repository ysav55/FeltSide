# 0002 — Five manifest files do not exist in the old repo

**Context:** `legacy/LEGACY_MANIFEST.md` lists 17 files. Five are absent
from the old poker-trainer repo under any name or location (searched by
filename and by content keywords):

- `server/game/BoardGenerator.js`
- `server/game/EquityService.js`
- `client/src/utils/comboUtils.js`
- `client/src/components/RangeMatrix.jsx` (must-carry gold)
- `client/src/components/RangePicker.jsx` (must-carry gold)

Range-matrix-like UI appears to live inline inside
`client/src/components/HandConfigPanel.jsx`, which is NOT on the manifest,
so per manifest rule 1 it was neither copied nor read.

**Decision:** Imported the 12 files that exist; the five above are flagged
to Jo. If RangeMatrix/RangePicker were meant to be extracted from
HandConfigPanel (or live elsewhere), Jo should amend the manifest.

**Justification:** Manifest rule 1 forbids touching unlisted files; guessing
substitutes would smuggle unvetted code past the customs zone. None of the
five is needed before M4/M5.
