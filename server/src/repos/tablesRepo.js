export function buildTablesRepo(db) {
  return {
    async create({ mode, createdBy, config, status = 'open' }) {
      const { rows } = await db.query(
        `insert into tables (mode, status, created_by, config)
         values ($1, $2, $3, $4) returning *`,
        [mode, status, createdBy, JSON.stringify(config)]
      );
      return rows[0];
    },

    async findById(id) {
      const { rows } = await db.query('select * from tables where id = $1', [id]);
      return rows[0] || null;
    },

    // ── CRM lesson sync (CONTRACT §8) ─────────────────────────────────

    async createScheduled({ mode, config, crmEntryId, scheduledStart, scheduledEnd }) {
      const { rows } = await db.query(
        `insert into tables
           (mode, status, created_by, config, crm_entry_id,
            scheduled_start, scheduled_end)
         values ($1, 'scheduled', null, $2, $3, $4, $5) returning *`,
        [mode, JSON.stringify(config), crmEntryId, scheduledStart, scheduledEnd]
      );
      return rows[0];
    },

    /** Updates a SCHEDULED table only — a started table is never touched. */
    async updateScheduled(id, { mode, config, scheduledStart, scheduledEnd }) {
      const { rows } = await db.query(
        `update tables
            set mode = $2, config = $3, scheduled_start = $4,
                scheduled_end = $5, updated_at = now()
          where id = $1 and status = 'scheduled'
          returning *`,
        [id, mode, JSON.stringify(config), scheduledStart, scheduledEnd]
      );
      return rows[0] || null;
    },

    async listByCrmEntry() {
      const { rows } = await db.query(
        `select * from tables where crm_entry_id is not null`
      );
      return rows;
    },

    /** Deletes a SCHEDULED table only; started tables survive by construction. */
    async deleteScheduled(id) {
      const { rowCount } = await db.query(
        `delete from tables where id = $1 and status = 'scheduled'`, [id]
      );
      return rowCount > 0;
    },

    /** RUNTIME §3: scheduled-never-started removed 24h after scheduled start. */
    async pruneStaleScheduled(cutoffIso) {
      const { rows } = await db.query(
        `delete from tables
          where status = 'scheduled' and scheduled_start < $1
          returning id`,
        [cutoffIso]
      );
      return rows.length;
    },

    async list() {
      const { rows } = await db.query(
        `select id, mode, status, created_by, config, crm_entry_id,
                scheduled_start, scheduled_end, seats, created_at, updated_at
           from tables
          where status <> 'completed'
          order by scheduled_start nulls first, created_at`
      );
      return rows;
    },

    async listNonCompleted() {
      const { rows } = await db.query(
        `select * from tables where status <> 'completed' order by created_at`
      );
      return rows;
    },

    async setStatus(id, status) {
      const { rows } = await db.query(
        `update tables set status = $2, updated_at = now()
         where id = $1 returning *`,
        [id, status]
      );
      return rows[0] || null;
    },

    async updateConfig(id, config) {
      await db.query(
        `update tables set config = $2, updated_at = now() where id = $1`,
        [id, JSON.stringify(config)]
      );
    },

    /** RUNTIME §1: seat/stack snapshot after every completed hand. */
    async saveSeats(id, seats) {
      await db.query(
        `update tables set seats = $2, updated_at = now() where id = $1`,
        [id, JSON.stringify(seats)]
      );
    },
  };
}
