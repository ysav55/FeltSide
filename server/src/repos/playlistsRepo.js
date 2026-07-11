export function buildPlaylistsRepo(db) {
  return {
    async create({ name, description = null, createdBy = null, scenarioIds = [] }) {
      const { rows } = await db.query(
        `insert into playlists (name, description, created_by)
         values ($1, $2, $3) returning *`,
        [name, description, createdBy]
      );
      const playlist = rows[0];
      await this.setScenarios(playlist.id, scenarioIds);
      return playlist;
    },

    async findById(id) {
      const { rows } = await db.query('select * from playlists where id = $1', [id]);
      return rows[0] || null;
    },

    /** Replace the ordered scenario list (idempotent full-set semantics). */
    async setScenarios(playlistId, scenarioIds) {
      await db.query('delete from playlist_scenarios where playlist_id = $1', [playlistId]);
      for (let i = 0; i < scenarioIds.length; i++) {
        await db.query(
          `insert into playlist_scenarios (playlist_id, scenario_id, position)
           values ($1, $2, $3)`,
          [playlistId, scenarioIds[i], i]
        );
      }
      await db.query('update playlists set updated_at = now() where id = $1', [playlistId]);
    },

    /** Ordered scenarios of a playlist (drill order). */
    async listScenarios(playlistId) {
      const { rows } = await db.query(
        `select s.*, ps.position
           from playlist_scenarios ps
           join scenarios s on s.id = ps.scenario_id
          where ps.playlist_id = $1
          order by ps.position`,
        [playlistId]
      );
      return rows;
    },

    async list() {
      const { rows } = await db.query(
        `select p.*,
                (select count(*)::int from playlist_scenarios ps
                  where ps.playlist_id = p.id) as scenario_count
           from playlists p
          order by p.created_at desc`
      );
      return rows;
    },

    async update(id, { name, description }) {
      const { rows } = await db.query(
        `update playlists
            set name = coalesce($2, name),
                description = coalesce($3, description),
                updated_at = now()
          where id = $1 returning *`,
        [id, name ?? null, description ?? null]
      );
      return rows[0] || null;
    },

    async remove(id) {
      const { rowCount } = await db.query('delete from playlists where id = $1', [id]);
      return rowCount > 0;
    },
  };
}
