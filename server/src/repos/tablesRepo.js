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

    async list() {
      const { rows } = await db.query(
        `select id, mode, status, created_by, config, crm_entry_id,
                seats, created_at, updated_at
           from tables
          where status <> 'completed'
          order by created_at`
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

    /** RUNTIME §1: seat/stack snapshot after every completed hand. */
    async saveSeats(id, seats) {
      await db.query(
        `update tables set seats = $2, updated_at = now() where id = $1`,
        [id, JSON.stringify(seats)]
      );
    },
  };
}
