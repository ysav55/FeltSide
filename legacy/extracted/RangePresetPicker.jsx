// EXTRACTED raw material (M2 Step 0.2c) — not a working module.
// Source: client/src/components/HandConfigPanel.jsx in the old repo.
// Stands in for the manifest's missing RangeMatrix.jsx / RangePicker.jsx /
// comboUtils.js. NOTE: the old repo never had a 13×13 range matrix — its
// range UI was this preset-chip picker plus combo-intersection logic on top
// of rangeParser (legacy/client/rangeParser.js, already imported).
// The M4/M5 range-matrix editor must be built new; this is the closest
// existing material (preset vocabulary + intersection semantics).

import { parseRange } from '../client/rangeParser.js';

// Build "all suited" and "all offsuit" range strings programmatically
const _R = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
const _suitedParts = [];
const _offsuitParts = [];
for (let i = _R.length - 1; i >= 1; i--) {
  for (let j = i - 1; j >= 0; j--) {
    _suitedParts.push(`${_R[i]}${_R[j]}s`);
    _offsuitParts.push(`${_R[i]}${_R[j]}o`);
  }
}

export const PRESET_GROUPS = [
  { label: 'PAIRS',    tags: ['all_pairs', 'premium_pairs', 'medium_pairs', 'small_pairs'] },
  { label: 'SUIT',     tags: ['suited', 'offsuit'] },
  { label: 'TYPE',     tags: ['broadway', 'connectors', 'one_gappers', 'ace_high', 'king_high'] },
  { label: 'SHORTCUT', tags: ['ato_plus', 'kjo_plus', 'premium', 'strong'] },
];

export const PRESET_META = {
  all_pairs:     { label: 'All Pairs',  rangeStr: 'AA-22' },
  premium_pairs: { label: 'QQ+',        rangeStr: 'QQ+' },
  medium_pairs:  { label: '77-JJ',      rangeStr: 'JJ-77' },
  small_pairs:   { label: '22-66',      rangeStr: '66-22' },
  suited:        { label: 'Suited',     rangeStr: _suitedParts.join(',') },
  offsuit:       { label: 'Offsuit',    rangeStr: _offsuitParts.join(',') },
  broadway:      { label: 'Broadway',   rangeStr: 'AKs,AKo,AQs,AQo,AJs,AJo,ATs,ATo,KQs,KQo,KJs,KJo,KTs,KTo,QJs,QJo,QTs,QTo,JTs,JTo' },
  connectors:    { label: 'Connectors', rangeStr: 'AKs,AKo,KQs,KQo,QJs,QJo,JTs,JTo,T9s,T9o,98s,98o,87s,87o,76s,76o,65s,65o,54s,54o,43s,43o,32s,32o' },
  one_gappers:   { label: '1-Gap',      rangeStr: 'AQs,AQo,KJs,KJo,QTs,QTo,J9s,J9o,T8s,T8o,97s,97o,86s,86o,75s,75o,64s,64o,53s,53o,42s,42o' },
  ace_high:      { label: 'Ace-high',   rangeStr: 'AKs,AKo,AQs,AQo,AJs,AJo,ATs,ATo,A9s,A9o,A8s,A8o,A7s,A7o,A6s,A6o,A5s,A5o,A4s,A4o,A3s,A3o,A2s,A2o' },
  king_high:     { label: 'King-high',  rangeStr: 'KQs,KQo,KJs,KJo,KTs,KTo,K9s,K9o,K8s,K8o,K7s,K7o,K6s,K6o,K5s,K5o,K4s,K4o,K3s,K3o,K2s,K2o' },
  ato_plus:      { label: 'ATo+',       rangeStr: 'ATs,ATo,AJs,AJo,AQs,AQo,AKs,AKo' },
  kjo_plus:      { label: 'KJo+',       rangeStr: 'KJs,KJo,KQs,KQo' },
  premium:       { label: 'Premium',    rangeStr: 'AA,KK,QQ,JJ,TT,AKs,AKo' },
  strong:        { label: 'Strong',     rangeStr: 'AA,KK,QQ,JJ,TT,99,88,77,AKs,AKo,AQs,AQo,AJs,AJo,ATs,ATo,KQs,KQo' },
};

// Map each preset tag to its group label (for radio-within-group behaviour)
export const PRESET_GROUP_OF = {};
PRESET_GROUPS.forEach(({ label, tags }) => tags.forEach(t => { PRESET_GROUP_OF[t] = label; }));

// Expand preset IDs → intersected combo list [[card, card], ...]
export function computePresetCombos(presetIds) {
  if (!presetIds.length) return [];
  const sets = presetIds.map(id => {
    const meta = PRESET_META[id];
    if (!meta) return new Set();
    const combos = parseRange(meta.rangeStr);
    return new Set(combos.map(([c1, c2]) => [c1, c2].sort().join(',')));
  });
  const [first, ...rest] = sets;
  const intersection = new Set([...first].filter(k => rest.every(s => s.has(k))));
  return [...intersection].map(k => k.split(','));
}

// The chip-grid rendering from HandConfigPanel (per-player preset picker,
// radio-within-group behaviour, combo-count feedback) is documented here as
// the interaction pattern to rebuild against; the JSX itself was tangled
// with the old app's gameState/emit plumbing and coach-panel styling, so
// only the data layer above was lifted verbatim.
