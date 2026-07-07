/**
 * Read side for the review page & hand-history browser (M6). All camelCased
 * to feed ReplayEngine.buildReplay directly. Coach-facing: hole cards are
 * always included (post-hoc review is open-kimono, PRD §5).
 */
/** pg reports affected rows as `rowCount`; PGlite (tests) as `affectedRows`. */
const affected = (r) => r.rowCount ?? r.affectedRows ?? 0;

export function buildHandReadRepo(db) {
  return {
    /** Full hand detail for replay: participants, actions, live tags, annotations. */
    async getHandDetail(handId) {
      const { rows: hands } = await db.query(
        `select h.id, h.session_id, h.origin, h.played_at, h.board, h.pot,
                h.revision, s.table_id, s.table_mode, s.coach_player_id
           from hands h join sessions s on s.id = h.session_id
          where h.id = $1`,
        [handId]
      );
      if (hands.length === 0) return null;
      const h = hands[0];

      const { rows: participants } = await db.query(
        `select hp.player_id, p.display_name as name, hp.position, hp.hole_cards,
                hp.stack_start, hp.stack_end, hp.is_winner
           from hand_participants hp join players p on p.id = hp.player_id
          where hp.hand_id = $1
          order by hp.position`,
        [handId]
      );
      const { rows: actions } = await db.query(
        `select seq, player_id, street, action, amount, reverted
           from hand_actions where hand_id = $1 order by seq`,
        [handId]
      );
      const { rows: tags } = await db.query(
        `select id, tag, tag_type, player_id, action_seq, dismissed
           from hand_tags where hand_id = $1 order by id`,
        [handId]
      );
      const { rows: annotations } = await db.query(
        `select id, action_index, body, created_by, created_at
           from hand_annotations where hand_id = $1 order by action_index, created_at`,
        [handId]
      );

      return {
        handId: h.id,
        sessionId: h.session_id,
        tableId: h.table_id,
        tableMode: h.table_mode,
        coachPlayerId: h.coach_player_id,
        origin: h.origin,
        playedAt: h.played_at,
        revision: h.revision,
        pot: Number(h.pot),
        board: h.board,
        participants: participants.map((p) => ({
          playerId: p.player_id,
          name: p.name,
          position: p.position,
          holeCards: p.hole_cards,
          stackStart: Number(p.stack_start),
          stackEnd: Number(p.stack_end),
          isWinner: p.is_winner,
        })),
        actions: actions.map((a) => ({
          seq: Number(a.seq),
          playerId: a.player_id,
          street: a.street,
          action: a.action,
          amount: Number(a.amount),
          reverted: a.reverted,
        })),
        tags: tags.map((t) => ({
          id: Number(t.id),
          tag: t.tag,
          tagType: t.tag_type,
          playerId: t.player_id,
          actionSeq: t.action_seq === null ? null : Number(t.action_seq),
          dismissed: t.dismissed,
        })),
        annotations: annotations.map((a) => ({
          id: a.id,
          actionIndex: Number(a.action_index),
          body: a.body,
          createdBy: a.created_by,
          createdAt: a.created_at,
        })),
      };
    },

    /**
     * Filterable hand list for the browser. Filters: tableId, sessionId,
     * playerId, tag, origin, from, to. Returns lightweight summaries.
     */
    async listHands({ tableId, sessionId, playerId, tag, origin, from, to, limit = 50, offset = 0 } = {}) {
      const where = [];
      const params = [];
      const add = (clause, value) => { params.push(value); where.push(clause.replace('$$', `$${params.length}`)); };

      if (sessionId) add('h.session_id = $$', sessionId);
      if (tableId) add('s.table_id = $$', tableId);
      if (origin) add('h.origin = $$', origin);
      if (from) add('h.played_at >= $$', from);
      if (to) add('h.played_at <= $$', to);
      if (playerId) add('exists (select 1 from hand_participants hp where hp.hand_id = h.id and hp.player_id = $$)', playerId);
      if (tag) add('exists (select 1 from hand_tags ht where ht.hand_id = h.id and ht.tag = $$ and not ht.dismissed)', tag);

      const whereSql = where.length ? `where ${where.join(' and ')}` : '';
      params.push(limit); const limIdx = params.length;
      params.push(offset); const offIdx = params.length;

      const { rows } = await db.query(
        `select h.id, h.session_id, s.table_id, s.table_mode, h.origin,
                h.played_at, h.pot, h.revision,
                (select count(*)::int from hand_participants hp where hp.hand_id = h.id) as player_count,
                (select count(*)::int from hand_tags ht where ht.hand_id = h.id and not ht.dismissed) as tag_count,
                (select array_agg(distinct ht.tag) from hand_tags ht where ht.hand_id = h.id and not ht.dismissed) as tags,
                (select p.display_name from hand_participants hp join players p on p.id = hp.player_id
                   where hp.hand_id = h.id and hp.is_winner limit 1) as winner_name
           from hands h join sessions s on s.id = h.session_id
           ${whereSql}
          order by h.played_at desc
          limit $${limIdx} offset $${offIdx}`,
        params
      );
      return rows.map((r) => ({
        handId: r.id,
        sessionId: r.session_id,
        tableId: r.table_id,
        tableMode: r.table_mode,
        origin: r.origin,
        playedAt: r.played_at,
        pot: Number(r.pot),
        revision: r.revision,
        playerCount: r.player_count,
        tagCount: r.tag_count,
        tags: r.tags ?? [],
        winnerName: r.winner_name,
      }));
    },

    // ── Annotations (coach; engine-side only, never exported) ────────────

    async addAnnotation(handId, { actionIndex, body, createdBy }) {
      const { rows } = await db.query(
        `insert into hand_annotations (hand_id, action_index, body, created_by)
         values ($1, $2, $3, $4) returning *`,
        [handId, actionIndex, body, createdBy]
      );
      const a = rows[0];
      return { id: a.id, actionIndex: a.action_index, body: a.body, createdBy: a.created_by, createdAt: a.created_at };
    },

    async removeAnnotation(annotationId) {
      const r = await db.query('delete from hand_annotations where id = $1', [annotationId]);
      return affected(r) > 0;
    },

    // ── Retag support (coach; each mutation bumps the hand revision) ─────

    async getTag(tagId) {
      const { rows } = await db.query('select * from hand_tags where id = $1', [tagId]);
      return rows[0] || null;
    },

    async handIdForTag(tagId) {
      const { rows } = await db.query('select hand_id from hand_tags where id = $1', [tagId]);
      return rows[0]?.hand_id ?? null;
    },

    async setTagDismissed(tagId, dismissed) {
      const { rows } = await db.query(
        `update hand_tags set dismissed = $2 where id = $1 returning *`,
        [tagId, dismissed]
      );
      return rows[0] || null;
    },

    async removeCoachTag(tagId) {
      const r = await db.query(
        `delete from hand_tags where id = $1 and tag_type = 'coach'`, [tagId]
      );
      return affected(r) > 0;
    },

    async handExists(handId) {
      const { rows } = await db.query('select 1 from hands where id = $1', [handId]);
      return rows.length > 0;
    },
  };
}
