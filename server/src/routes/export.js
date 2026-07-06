import { Router } from 'express';
import { buildContractAuth } from './contractAuth.js';
import { encodeCursor, decodeCursor } from '../export/cursor.js';
import { TAG_VOCABULARY, TAG_VOCABULARY_VERSION } from '../export/vocabulary.js';

/**
 * /export/v1 — the read-only export API (CONTRACT §§2–4, §6, §7).
 *
 * All responses are exact CONTRACT shapes. Numeric DB values arrive as
 * strings (pg bigint) or numbers (PGlite) — everything is normalized to
 * JSON numbers, timestamps to UTC ISO-8601 strings.
 */

export const ENGINE_VERSION = '0.3.0'; // M3

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function buildExportRoutes({ exportRepo, config }) {
  const router = Router();
  router.use(buildContractAuth(config));

  // §4.1 — health + vocabulary handshake.
  router.get('/meta', (req, res) => {
    res.json({
      engine_version: ENGINE_VERSION,
      contract_version: 1,
      tag_vocabulary_version: TAG_VOCABULARY_VERSION,
      tags: TAG_VOCABULARY,
    });
  });

  // §4.2 — full player snapshot, no cursor.
  router.get('/players', async (req, res, next) => {
    try {
      const rows = await exportRepo.listPlayers();
      res.json({
        data: rows.map((p) => ({
          player_id: p.id,
          display_name: p.display_name,
          crm_student_id: p.crm_student_id ?? null,
          status: p.status,
          created_at: iso(p.created_at),
        })),
      });
    } catch (err) { next(err); }
  });

  // §4.3 — completed sessions, cursored.
  router.get('/sessions', async (req, res, next) => {
    try {
      const q = parseCursorQuery(req, res);
      if (!q) return;
      const { page, hasMore, participantsBySession } =
        await exportRepo.pageSessions({ afterSeq: q.afterSeq, limit: q.limit });
      res.json(envelope(page, hasMore, (s) => ({
        session_id: s.id,
        crm_entry_id: s.crm_entry_id ?? null,
        table_mode: s.table_mode,
        started_at: iso(s.started_at),
        ended_at: iso(s.ended_at),
        hand_count: Number(s.hand_count),
        coach_player_id: null, // coached tables arrive in M4
        participants: (participantsBySession.get(s.id) ?? []).map((p) => ({
          player_id: p.player_id,
          crm_student_id: p.crm_student_id ?? null,
          hands_played: Number(p.hands_played),
          net_chips: Number(p.net_chips),
          finish_position: null, // tournaments arrive in M7
        })),
      })));
    } catch (err) { next(err); }
  });

  // §4.4 — completed hands, cursored. tags: [] until M5.
  router.get('/hands', async (req, res, next) => {
    try {
      const q = parseCursorQuery(req, res);
      if (!q) return;
      const { page, hasMore, participantsByHand, actionsByHand } =
        await exportRepo.pageHands({ afterSeq: q.afterSeq, limit: q.limit });
      res.json(envelope(page, hasMore, (h) => ({
        hand_id: h.id,
        session_id: h.session_id,
        table_mode: h.table_mode,
        origin: h.origin,
        played_at: iso(h.played_at),
        revision: Number(h.revision),
        review_url: `${config.publicBaseUrl}/review/${h.id}`,
        board: h.board,
        pot: Number(h.pot),
        participants: (participantsByHand.get(h.id) ?? []).map((p) => ({
          player_id: p.player_id,
          crm_student_id: p.crm_student_id ?? null,
          position: p.position,
          hole_cards: p.hole_cards ?? null,
          stack_start: Number(p.stack_start),
          stack_end: Number(p.stack_end),
          is_winner: p.is_winner,
          vpip: p.vpip,
          pfr: p.pfr,
          three_bet_opp: p.three_bet_opp,
          three_bet: p.three_bet,
          saw_flop: p.saw_flop,
          cbet_opp: p.cbet_opp,
          cbet: p.cbet,
          wtsd: p.wtsd,
          wsd: p.wsd,
        })),
        actions: (actionsByHand.get(h.id) ?? []).map((a) => ({
          seq: Number(a.seq),
          player_id: a.player_id,
          street: a.street,
          action: a.action,
          amount: Number(a.amount),
        })),
        tags: [], // M5 populates; the shape is live now
      })));
    } catch (err) { next(err); }
  });

  // §4.6 — playlist catalog snapshot; valid empty catalog until M4.
  router.get('/playlists', (req, res) => {
    res.json({ data: [] });
  });

  // §4.7 — tournament-preset catalog snapshot; valid empty catalog until M7.
  router.get('/tournament-presets', (req, res) => {
    res.json({ data: [] });
  });

  return router;
}

/** §3 request params. Replies 400 invalid_cursor (and returns null) on garbage. */
function parseCursorQuery(req, res) {
  let afterSeq = '0';
  if (req.query.cursor !== undefined) {
    const seq = decodeCursor(req.query.cursor);
    if (seq === null) {
      res.status(400).json({ code: 'invalid_cursor' });
      return null;
    }
    afterSeq = seq;
  }
  const parsed = Number.parseInt(req.query.limit, 10);
  const limit = Number.isInteger(parsed)
    ? Math.min(Math.max(parsed, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  return { afterSeq, limit };
}

/** §3 response envelope over a mapped page ordered by export_seq. */
function envelope(page, hasMore, mapFn) {
  return {
    data: page.map(mapFn),
    next_cursor: page.length > 0
      ? encodeCursor(String(page[page.length - 1].export_seq))
      : null,
    has_more: hasMore,
  };
}

function iso(v) {
  if (v == null) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}
