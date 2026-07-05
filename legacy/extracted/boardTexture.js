// EXTRACTED raw material (M2 Step 0.2c) — not a working module.
// Source: legacy/game/HandGenerator.js (board-texture section).
// Stands in for the manifest's missing BoardGenerator.js: flop texture
// classification/constraints + validation. Needs RANK_INDEX ('2'..'A' → 0..12)
// and card strings like 'Ah' to become a standalone module.

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const RANK_INDEX = Object.fromEntries(RANKS.map((r, i) => [r, i]));

/**
 * Best span of a 3-card flop, considering ace duality (high OR low).
 * Span = sorted[2] - sorted[0].
 * When an ace is present, also try ace as low (index -1, below '2') and
 * return the smaller of the two spans.
 *
 * Examples:
 *   789  → span 2 (connected)
 *   Q23  → span 10 (disconnected — 2-3 adjacency is irrelevant)
 *   A23  → min(12, 2) = 2 (connected — wheel draw A-2-3-4-5)
 *   A52  → min(12, 4) = 4 (one-gap — wheel draw possible with 3-4)
 *   AKQ  → span 2 (connected broadway)
 */
export function flopBestSpan(flop) {
  const ranks  = flop.map(c => c[0]);
  const idxs   = ranks.map(r => RANK_INDEX[r]).sort((a, b) => a - b);
  const normal = idxs[2] - idxs[0];
  if (!ranks.includes('A')) return normal;
  // Ace-low: treat A as -1 (below 2)
  const low = idxs.map(i => i === 12 ? -1 : i).sort((a, b) => a - b);
  return Math.min(normal, low[2] - low[0]);
}

/**
 * Check if a 3-card flop satisfies all requested texture constraints.
 * textures: string[] from the supported set below.
 */
export function flopSatisfiesTexture(flop, textures) {
  if (!textures || textures.length === 0) return true;

  const [c1, c2, c3] = flop;
  const suits = [c1[1], c2[1], c3[1]];
  const ranks = [c1[0], c2[0], c3[0]];

  for (const t of textures) {
    switch (t) {
      // ── Suit texture ──────────────────────────────────────────────────────
      case 'rainbow': {
        if (new Set(suits).size !== 3) return false;
        break;
      }
      case 'flush_draw': {
        // exactly 2 cards share a suit
        const suitCounts = suits.reduce((m, s) => { m[s] = (m[s] || 0) + 1; return m; }, {});
        const maxSuit = Math.max(...Object.values(suitCounts));
        if (maxSuit !== 2) return false;
        break;
      }
      case 'monotone': {
        if (new Set(suits).size !== 1) return false;
        break;
      }

      // ── Pair texture ──────────────────────────────────────────────────────
      case 'unpaired': {
        if (new Set(ranks).size !== 3) return false;
        break;
      }
      case 'paired': {
        // exactly one pair (2 ranks the same, 3rd different)
        if (new Set(ranks).size !== 2) return false;
        const rankCounts = ranks.reduce((m, r) => { m[r] = (m[r] || 0) + 1; return m; }, {});
        if (!Object.values(rankCounts).includes(2)) return false;
        break;
      }
      case 'trips': {
        if (new Set(ranks).size !== 1) return false;
        break;
      }

      // ── Connectedness (span-based, ace counts high OR low) ───────────────
      // span ≤ 2 → connected (e.g. 7-8-9, A-2-3 via ace-low)
      // span 3-4 → one-gap   (e.g. 6-7-9, A-2-5 via ace-low)
      // span > 4 → disconnected (e.g. Q-2-3 — pair adjacency is irrelevant)
      case 'connected': {
        if (flopBestSpan(flop) > 2) return false;
        break;
      }
      case 'one_gap': {
        const span1 = flopBestSpan(flop);
        if (span1 < 3 || span1 > 4) return false;
        break;
      }
      case 'disconnected': {
        if (flopBestSpan(flop) <= 4) return false;
        break;
      }

      // ── High card ─────────────────────────────────────────────────────────
      case 'broadway': {
        const broadwayRanks = new Set(['T', 'J', 'Q', 'K', 'A']);
        if (!ranks.some(r => broadwayRanks.has(r))) return false;
        break;
      }
      case 'mid': {
        // all 3 cards 8-J (index 6-9), no T+ gap to broadway, no ace
        if (!ranks.every(r => RANK_INDEX[r] >= 6 && RANK_INDEX[r] <= 9)) return false;
        break;
      }
      case 'low': {
        // all 3 cards 9 or lower (index ≤ 7)
        if (!ranks.every(r => RANK_INDEX[r] <= 7)) return false;
        break;
      }
      case 'ace_high': {
        if (!ranks.includes('A')) return false;
        break;
      }

      // ── Composite ─────────────────────────────────────────────────────────
      case 'wet': {
        // flush draw (2+ same suit) AND connected/one-gap (span ≤ 4)
        const sc = suits.reduce((m, s) => { m[s] = (m[s] || 0) + 1; return m; }, {});
        if (Math.max(...Object.values(sc)) < 2) return false;
        if (flopBestSpan(flop) > 4) return false;
        break;
      }
      case 'dry': {
        // rainbow AND disconnected (span > 4)
        if (new Set(suits).size !== 3) return false;
        if (flopBestSpan(flop) <= 4) return false;
        break;
      }

      default:
        // Unknown texture constraint — ignore
        break;
    }
  }
  return true;
}

/**
 * Validate board_texture array for incompatible combinations.
 * Returns { valid: true } or { valid: false, error: string }.
 */
export function validateBoardTexture(textures) {
  if (!textures || textures.length === 0) return { valid: true };

  const suitGroup      = ['rainbow', 'flush_draw', 'monotone'];
  const pairGroup      = ['unpaired', 'paired', 'trips'];
  const connGroup      = ['connected', 'one_gap', 'disconnected'];
  const highGroup      = ['broadway', 'mid', 'low', 'ace_high'];
  const compositeGroup = ['wet', 'dry'];

  // At most one from each group (mutually exclusive within group)
  for (const group of [suitGroup, pairGroup, connGroup, highGroup, compositeGroup]) {
    const active = textures.filter(t => group.includes(t));
    if (active.length > 1) {
      return { valid: false, error: `Incompatible board textures: ${active.join(' + ')}` };
    }
  }

  // Composite conflicts
  if (textures.includes('wet') && textures.includes('rainbow'))
    return { valid: false, error: 'wet requires a flush draw — incompatible with rainbow' };
  if (textures.includes('wet') && textures.includes('disconnected'))
    return { valid: false, error: 'wet requires a connected/one-gap board — incompatible with disconnected' };
  if (textures.includes('dry') && (textures.includes('flush_draw') || textures.includes('monotone')))
    return { valid: false, error: 'dry requires rainbow — incompatible with flush_draw/monotone' };
  if (textures.includes('dry') && (textures.includes('connected') || textures.includes('one_gap')))
    return { valid: false, error: 'dry requires disconnected — incompatible with connected/one_gap' };

  // Height conflicts
  if (textures.includes('broadway') && textures.includes('low'))
    return { valid: false, error: 'broadway and low are incompatible' };
  if (textures.includes('ace_high') && textures.includes('low'))
    return { valid: false, error: 'ace_high and low are incompatible' };
  if (textures.includes('ace_high') && textures.includes('mid'))
    return { valid: false, error: 'ace_high and mid are incompatible' };

  return { valid: true };
}
