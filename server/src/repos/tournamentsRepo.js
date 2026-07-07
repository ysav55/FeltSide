/** pg reports affected rows as `rowCount`; PGlite (tests) as `affectedRows`. */
const affected = (r) => r.rowCount ?? r.affectedRows ?? 0;

export function buildTournamentPresetsRepo(db) {
  return {
    async create({ name, description = null, config, createdBy = null }) {
      const { rows } = await db.query(
        `insert into tournament_presets (name, description, config, created_by)
         values ($1, $2, $3, $4) returning *`,
        [name, description, JSON.stringify(config), createdBy]
      );
      return rows[0];
    },

    async findById(id) {
      // Preset ids arrive by reference from the CRM (§4.7/§8) — a malformed
      // id is "not found", never a query error.
      if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(id))) return null;
      const { rows } = await db.query('select * from tournament_presets where id = $1', [id]);
      return rows[0] || null;
    },

    async list() {
      const { rows } = await db.query('select * from tournament_presets order by created_at');
      return rows;
    },

    async update(id, { name, description, config }) {
      const { rows } = await db.query(
        `update tournament_presets
            set name = coalesce($2, name),
                description = coalesce($3, description),
                config = coalesce($4, config),
                updated_at = now()
          where id = $1 returning *`,
        [id, name ?? null, description ?? null, config ? JSON.stringify(config) : null]
      );
      return rows[0] || null;
    },

    async remove(id) {
      const r = await db.query('delete from tournament_presets where id = $1', [id]);
      return affected(r) > 0;
    },

    async count() {
      const { rows } = await db.query('select count(*)::int as n from tournament_presets');
      return rows[0].n;
    },
  };
}

export function buildTournamentsRepo(db) {
  return {
    async create({ tableId, presetId = null, config }) {
      const { rows } = await db.query(
        `insert into tournaments (table_id, preset_id, config)
         values ($1, $2, $3) returning *`,
        [tableId, presetId, JSON.stringify(config)]
      );
      return rows[0];
    },

    async findById(id) {
      const { rows } = await db.query('select * from tournaments where id = $1', [id]);
      return rows[0] || null;
    },

    async findByTableId(tableId) {
      const { rows } = await db.query('select * from tournaments where table_id = $1', [tableId]);
      return rows[0] || null;
    },

    async listActive() {
      const { rows } = await db.query(
        `select * from tournaments where status <> 'completed' order by created_at`
      );
      return rows;
    },

    async setStatus(id, status, extra = {}) {
      const { rows } = await db.query(
        `update tournaments
            set status = $2,
                started_at = coalesce(started_at, case when $2 = 'running' then now() end),
                completed_at = case when $2 = 'completed' then now() else completed_at end
          where id = $1 returning *`,
        [id, status]
      );
      void extra;
      return rows[0] || null;
    },

    /** RUNTIME §1 safety snapshot: clock + tables layout, in one jsonb. */
    async saveState(id, state) {
      await db.query('update tournaments set state = $2 where id = $1', [id, JSON.stringify(state)]);
    },

    // ── Entries ─────────────────────────────────────────────────────────

    async upsertEntry({ tournamentId, playerId, paid }) {
      const { rows } = await db.query(
        `insert into tournament_entries (tournament_id, player_id, total_paid)
         values ($1, $2, $3)
         on conflict (tournament_id, player_id) do update
           set entries = tournament_entries.entries + 1,
               total_paid = tournament_entries.total_paid + $3,
               finish_position = null, eliminated_at = null
         returning *`,
        [tournamentId, playerId, paid]
      );
      return rows[0];
    },

    async setAddon(tournamentId, playerId, paid) {
      const { rows } = await db.query(
        `update tournament_entries
            set addon = true, total_paid = total_paid + $3
          where tournament_id = $1 and player_id = $2 and addon = false
          returning *`,
        [tournamentId, playerId, paid]
      );
      return rows[0] || null;
    },

    async listEntries(tournamentId) {
      const { rows } = await db.query(
        `select te.*, p.display_name as name
           from tournament_entries te join players p on p.id = te.player_id
          where te.tournament_id = $1
          order by te.created_at`,
        [tournamentId]
      );
      return rows;
    },

    async setFinish(tournamentId, playerId, finishPosition) {
      await db.query(
        `update tournament_entries
            set finish_position = $3, eliminated_at = now()
          where tournament_id = $1 and player_id = $2`,
        [tournamentId, playerId, finishPosition]
      );
    },

    async setPayout(tournamentId, playerId, payout) {
      await db.query(
        `update tournament_entries set payout = $3
          where tournament_id = $1 and player_id = $2`,
        [tournamentId, playerId, payout]
      );
    },

    /** finish_position per player for the session export (CONTRACT §4.3). */
    async finishPositionsBySession(tableIds) {
      if (tableIds.length === 0) return new Map();
      const { rows } = await db.query(
        `select t.table_id, te.player_id, te.finish_position, te.entries, te.payout
           from tournaments t join tournament_entries te on te.tournament_id = t.id
          where t.table_id = any($1)`,
        [tableIds]
      );
      const map = new Map();
      for (const r of rows) {
        if (!map.has(r.table_id)) map.set(r.table_id, new Map());
        map.get(r.table_id).set(r.player_id, {
          finishPosition: r.finish_position,
          entries: r.entries,
          payout: Number(r.payout),
        });
      }
      return map;
    },
  };
}
