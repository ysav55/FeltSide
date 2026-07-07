/**
 * Analyzer defaults (TAXONOMY §4, §6): seeded reference charts, thresholds,
 * kill switches. Everything here is coach-tunable from the Analyzer
 * Settings page; stored overrides deep-merge over these defaults.
 *
 * Chart seeding: standard published-range APPROXIMATIONS of widely-taught
 * 9-max opening and blind-defense ranges (tight-early → wide-late; BB
 * defends wider than SB; both defend wider vs later opens). Live network
 * sources were unreachable from this build environment — the shapes follow
 * the conventional charts every modern training site teaches; see
 * docs/decisions/0009. Every chart is coach-editable with per-chart reset.
 *
 * Position naming: the engine's position vocabulary (positions.js) uses
 * `MP` for the seat TAXONOMY calls `LJ` — same seat, engine name wins in
 * chart keys (docs/decisions/0009).
 */

export const DEFAULT_OPEN_CHARTS = {
  'UTG':   '77+,ATs+,KQs,AQo+',
  'UTG+1': '66+,ATs+,KJs+,QJs,AJo+,KQo',
  'UTG+2': '55+,A9s+,KTs+,QTs+,JTs,AJo+,KQo',
  'MP':    '44+,A7s+,K9s+,QTs+,JTs,T9s,ATo+,KJo+,QJo',
  'HJ':    '33+,A5s+,K9s+,Q9s+,J9s+,T9s,98s,ATo+,KTo+,QJo',
  'CO':    '22+,A2s+,K7s+,Q8s+,J8s+,T8s+,97s+,87s,76s,A9o+,KTo+,QTo+,JTo',
  'BTN':   '22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,54s,A2o+,K8o+,Q9o+,J8o+,T8o+',
  'SB':    '22+,A2s+,K5s+,Q7s+,J8s+,T8s+,97s+,87s,76s,A7o+,KTo+,QTo+,JTo',
};

export const DEFAULT_DEFEND_CHARTS = {
  // BB defend (call or 3-bet) keyed by the opener's position.
  BB: {
    'UTG':   '22+,A9s+,ATo+,KTs+,QTs+,JTs,T9s,98s,KQo',
    'UTG+1': '22+,A8s+,ATo+,KTs+,QTs+,JTs,T9s,98s,87s,KQo',
    'UTG+2': '22+,A7s+,A9o+,K9s+,Q9s+,J9s+,T9s,98s,87s,KJo+',
    'MP':    '22+,A5s+,A9o+,K9s+,Q9s+,J9s+,T8s+,97s+,87s,76s,KJo+,QJo',
    'HJ':    '22+,A4s+,A8o+,K8s+,Q8s+,J8s+,T8s+,97s+,86s+,76s,65s,KTo+,QTo+,JTo',
    'CO':    '22+,A2s+,A7o+,K6s+,Q8s+,J8s+,T7s+,97s+,86s+,75s+,65s,54s,KTo+,QTo+,JTo',
    'BTN':   '22+,A2s+,A5o+,K4s+,Q6s+,J7s+,T7s+,96s+,86s+,75s+,64s+,54s,K9o+,Q9o+,J9o+,T9o',
    'SB':    '22+,A2s+,A2o+,K2s+,Q5s+,J7s+,T7s+,96s+,86s+,75s+,65s,54s,K8o+,Q9o+,J9o+,T9o',
  },
  // SB defend keyed by the opener's position (no SB-vs-SB).
  SB: {
    'UTG':   '77+,ATs+,KQs,AQo+',
    'UTG+1': '66+,ATs+,KJs+,AJo+,KQo',
    'UTG+2': '66+,A9s+,KTs+,QTs+,JTs,AJo+,KQo',
    'MP':    '55+,A9s+,KTs+,QTs+,JTs,T9s,ATo+,KQo',
    'HJ':    '44+,A8s+,K9s+,Q9s+,JTs,T9s,ATo+,KJo+',
    'CO':    '33+,A7s+,K9s+,Q9s+,J9s+,T9s,98s,A9o+,KTo+,QJo',
    'BTN':   '22+,A2s+,K8s+,Q9s+,J9s+,T8s+,98s,87s,76s,A8o+,KTo+,QTo+,JTo',
  },
};

export const DEFAULT_THRESHOLDS = {
  allinFavoritePct: 60,           // equity > this → ALLIN_FAVORITE
  allinUnderdogPct: 40,           // equity < this → ALLIN_UNDERDOG
  missedRiverValueFloor: 'TWO_PAIR', // HAND_RANKS key
  missedRiverValueInPositionOnly: true,
  boardConnectedSpan: 4,          // BOARD_CONNECTED max rank span
  multiwayMinPlayers: 3,          // MULTIWAY player count
};

export function defaultAnalyzerSettings() {
  return {
    killSwitches: {},             // { [tag]: false } disables a tag globally
    thresholds: { ...DEFAULT_THRESHOLDS },
    charts: {
      open: { ...DEFAULT_OPEN_CHARTS },
      defend: {
        BB: { ...DEFAULT_DEFEND_CHARTS.BB },
        SB: { ...DEFAULT_DEFEND_CHARTS.SB },
      },
    },
  };
}

/** Stored coach overrides deep-merge over the defaults. */
export function mergeAnalyzerSettings(stored) {
  stored = stored ?? {}; // null-safe: an empty settings table means defaults
  const d = defaultAnalyzerSettings();
  return {
    killSwitches: { ...d.killSwitches, ...(stored.killSwitches ?? {}) },
    thresholds: { ...d.thresholds, ...(stored.thresholds ?? {}) },
    charts: {
      open: { ...d.charts.open, ...(stored.charts?.open ?? {}) },
      defend: {
        BB: { ...d.charts.defend.BB, ...(stored.charts?.defend?.BB ?? {}) },
        SB: { ...d.charts.defend.SB, ...(stored.charts?.defend?.SB ?? {}) },
      },
    },
  };
}
