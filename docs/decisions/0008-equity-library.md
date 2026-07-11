# 0008 — Equity via poker-odds-calculator

**Context:** M5 needs equity at the all-in moment (TAXONOMY §2 ALLIN_*)
and later for review overlays. Command decision: a maintained library,
never hand-rolled.

**Candidates evaluated:**

| Library | Verdict |
|---|---|
| `poker-odds-calculator` (0.4.0, MIT) | **Adopted.** Registry activity into 2025; exact enumeration postflop, 100k-iteration Monte Carlo preflop; clean CardGroup/OddsCalculator API; passes every vector below. |
| `poker-tools` (1.3.10, MIT) | Runner-up. A fork of the same lineage, unmaintained since 2022, same API but stale; no reason to prefer it. |

**Verification vectors (pinned in test/analyzers.test.js):**

| Matchup | Expected | Measured |
|---|---|---|
| AA vs KK preflop | ≈ 82 / 18 | 82.5 / 18 (win 82 + tie 1) |
| AKs vs QQ preflop | ≈ 46 / 54 | 46 / 54 |
| AA vs KK on 2c 7s Jh 3d (turn) | AA ≈ 95 | 95 / 5 (exact) |
| KK vs AA on As 7s 2h 3d 9c (river) | 0 / 100 | 0 / 100 (exact) |

**Consequences:** preflop numbers carry ±~0.5pp Monte Carlo noise — ample
against the coach-tunable 60/40 ALLIN thresholds; postflop judgments are
exact. The adapter (`src/analyzers/equity.js`) is the single import site,
so swapping vendors later is one file.
