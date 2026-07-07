import { Router } from 'express';
import { mergeAnalyzerSettings, defaultAnalyzerSettings } from '../analyzers/defaults.js';
import { validateRange } from '../game/RangeParser.js';
import { TAG_VOCABULARY } from '../export/vocabulary.js';

const KNOWN_TAGS = new Set(TAG_VOCABULARY.map((t) => t.tag));

/**
 * Analyzer Settings (TAXONOMY §6): charts, per-tag kill switches,
 * thresholds. Strictly NON-RETROACTIVE — the runtime snapshots settings at
 * deal/hand-start time, so a change here applies from the next hand on;
 * nothing here re-analyzes history.
 */
export function buildAnalyzerSettingsRoutes({ settingsRepo, requireAuth, requireCoach }) {
  const router = Router();
  router.use(requireAuth(), requireCoach);

  router.get('/', async (req, res, next) => {
    try {
      const stored = await settingsRepo.get('analyzer');
      res.json({
        settings: mergeAnalyzerSettings(stored ?? {}),
        defaults: defaultAnalyzerSettings(),
        tags: TAG_VOCABULARY, // the kill-switch list mirrors the vocabulary
      });
    } catch (err) { next(err); }
  });

  router.put('/', async (req, res, next) => {
    try {
      const body = req.body || {};
      const clean = { killSwitches: {}, thresholds: {}, charts: { open: {}, defend: { BB: {}, SB: {} } } };

      for (const [tagName, enabled] of Object.entries(body.killSwitches ?? {})) {
        if (!KNOWN_TAGS.has(tagName)) return res.status(400).json({ error: 'unknown_tag', tag: tagName });
        if (enabled === false) clean.killSwitches[tagName] = false;
      }
      const t = body.thresholds ?? {};
      const numeric = ['allinFavoritePct', 'allinUnderdogPct', 'boardConnectedSpan', 'multiwayMinPlayers'];
      for (const key of numeric) {
        if (t[key] !== undefined) {
          if (typeof t[key] !== 'number') return res.status(400).json({ error: 'invalid_threshold', key });
          clean.thresholds[key] = t[key];
        }
      }
      if (t.missedRiverValueFloor !== undefined) {
        if (!['ONE_PAIR', 'TWO_PAIR', 'THREE_OF_A_KIND', 'STRAIGHT', 'FLUSH'].includes(t.missedRiverValueFloor)) {
          return res.status(400).json({ error: 'invalid_threshold', key: 'missedRiverValueFloor' });
        }
        clean.thresholds.missedRiverValueFloor = t.missedRiverValueFloor;
      }
      if (t.missedRiverValueInPositionOnly !== undefined) {
        clean.thresholds.missedRiverValueInPositionOnly = Boolean(t.missedRiverValueInPositionOnly);
      }

      for (const [pos, range] of Object.entries(body.charts?.open ?? {})) {
        if (range !== null && !validateRange(range).valid) {
          return res.status(400).json({ error: 'invalid_range', chart: `open.${pos}` });
        }
        clean.charts.open[pos] = range;
      }
      for (const blind of ['BB', 'SB']) {
        for (const [pos, range] of Object.entries(body.charts?.defend?.[blind] ?? {})) {
          if (range !== null && !validateRange(range).valid) {
            return res.status(400).json({ error: 'invalid_range', chart: `defend.${blind}.${pos}` });
          }
          clean.charts.defend[blind][pos] = range;
        }
      }

      await settingsRepo.set('analyzer', clean);
      res.json({ settings: mergeAnalyzerSettings(clean) });
    } catch (err) { next(err); }
  });

  return router;
}
