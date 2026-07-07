import { analyzeHandDescriptors } from './handDescriptors.js';
import { analyzePlayerDescriptors } from './playerDescriptors.js';
import { analyzeAbsoluteMistakes } from './absoluteMistakes.js';
import { analyzeChartMistakes } from './chartMistakes.js';
import { mergeAnalyzerSettings } from './defaults.js';
import { log } from '../log.js';

/**
 * The analyzer pipeline (TAXONOMY §§1–4), run when a hand completes.
 *
 * - One analyzer failing NEVER blocks the others or hand recording:
 *   each module is isolated; failures are logged and swallowed.
 * - Settings are a snapshot the RUNTIME captures at DEAL/hand-start time and
 *   passes in here — strictly non-retroactive (§6): a settings change made
 *   while a hand is in flight applies only to the NEXT hand. The per-tag kill
 *   switch filters at the end.
 * - Analyzers see only non-reverted actions (undo marks, never erases).
 */
const MODULES = [
  ['hand-descriptors', analyzeHandDescriptors],
  ['player-descriptors', analyzePlayerDescriptors],
  ['absolute-mistakes', analyzeAbsoluteMistakes],
  ['chart-mistakes', analyzeChartMistakes],
];

export function analyzeHand(record, { settings, log = defaultLog } = {}) {
  const merged = mergeAnalyzerSettings(settings);
  const tags = [];
  for (const [name, run] of MODULES) {
    try {
      tags.push(...run(record, { settings: merged }));
    } catch (err) {
      log(name, err); // isolated: recording and the other analyzers proceed
    }
  }
  return tags.filter((t) => merged.killSwitches[t.tag] !== false);
}

function defaultLog(name, err) {
  // No console.log debug in committed code (PRD §12) — this is an error path.
  log.error('analyzer_failed', { analyzer: name, message: err?.message ?? String(err) });
}
