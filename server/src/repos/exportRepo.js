/**
 * Read-side queries for /export/v1 (CONTRACT §4). Completed-only by
 * construction: sessions gain export_seq at finalize, hands at record time
 * (a recorded hand IS complete). Ordering is export_seq asc — total and
 * stable (unique, stamped under the advisory lock in recordingRepo).
 */

export function buildExportRepo(db) {
  return {
    /** §4.2 — player accounts (the coach is not a player account). */
    async listPlayers() {
      const { rows } = await db.query(
        `select id, display_name, crm_student_id, status, created_at
           from players
          where role = 'player'
          order by created_at, id`
      );
      return rows;
    },

    /** §4.3 — one page of completed sessions after `afterSeq`. */
    async pageSessions({ afterSeq, limit }) {
      const { rows: sessions } = await db.query(
        `select id, table_mode, crm_entry_id, coach_player_id, started_at,
                ended_at, hand_count, export_seq
           from sessions
          where export_seq is not null and export_seq > $1
          order by export_seq
          limit $2`,
        [afterSeq, limit + 1]
      );
      const page = sessions.slice(0, limit);
      const hasMore = sessions.length > limit;

      let participantsBySession = new Map();
      if (page.length > 0) {
        const ids = page.map((s) => s.id);
        const { rows } = await db.query(
          `select h.session_id, hp.player_id, p.crm_student_id,
                  count(*)::int as hands_played,
                  sum(hp.stack_end - hp.stack_start) as net_chips
             from hands h
             join hand_participants hp on hp.hand_id = h.id
             join players p on p.id = hp.player_id
            where h.session_id = any($1)
            group by h.session_id, hp.player_id, p.crm_student_id
            order by hp.player_id`,
          [ids]
        );
        participantsBySession = groupBy(rows, (r) => r.session_id);
      }
      return { page, hasMore, participantsBySession };
    },

    /** §4.4 — one page of completed hands after `afterSeq`. */
    async pageHands({ afterSeq, limit }) {
      const { rows: hands } = await db.query(
        `select h.id, h.session_id, h.origin, h.played_at, h.board, h.pot,
                h.revision, h.export_seq, s.table_mode
           from hands h
           join sessions s on s.id = h.session_id
          where h.export_seq is not null and h.export_seq > $1
          order by h.export_seq
          limit $2`,
        [afterSeq, limit + 1]
      );
      const page = hands.slice(0, limit);
      const hasMore = hands.length > limit;

      let participantsByHand = new Map();
      let actionsByHand = new Map();
      let tagsByHand = new Map();
      if (page.length > 0) {
        const ids = page.map((h) => h.id);
        const { rows: participants } = await db.query(
          `select hp.*, p.crm_student_id
             from hand_participants hp
             join players p on p.id = hp.player_id
            where hp.hand_id = any($1)
            order by hp.player_id`,
          [ids]
        );
        participantsByHand = groupBy(participants, (r) => r.hand_id);

        const { rows: actions } = await db.query(
          `select hand_id, seq, player_id, street, action, amount, reverted
             from hand_actions
            where hand_id = any($1)
            order by hand_id, seq`,
          [ids]
        );
        actionsByHand = groupBy(actions, (r) => r.hand_id);

        const { rows: tagRows } = await db.query(
          `select hand_id, tag, tag_type, player_id, action_seq
             from hand_tags
            where hand_id = any($1)
            order by hand_id, id`,
          [ids]
        );
        tagsByHand = groupBy(tagRows, (r) => r.hand_id);
      }
      return { page, hasMore, participantsByHand, actionsByHand, tagsByHand };
    },

    /** §4.6 — playlist catalog snapshot (real since M4). */
    async listPlaylists() {
      const { rows } = await db.query(
        `select p.id, p.name, p.description, p.updated_at,
                (select count(*)::int from playlist_scenarios ps
                  where ps.playlist_id = p.id) as scenario_count
           from playlists p
          order by p.created_at`
      );
      return rows;
    },
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}
