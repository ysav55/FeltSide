export function buildScenariosRepo(db) {
  return {
    async create({ name, description = null, config, createdBy = null }) {
      const { rows } = await db.query(
        `insert into scenarios (name, description, config, created_by)
         values ($1, $2, $3, $4) returning *`,
        [name, description, JSON.stringify(config), createdBy]
      );
      return rows[0];
    },

    async findById(id) {
      const { rows } = await db.query('select * from scenarios where id = $1', [id]);
      return rows[0] || null;
    },

    async list() {
      const { rows } = await db.query(
        'select * from scenarios order by created_at desc'
      );
      return rows;
    },

    async update(id, { name, description, config }) {
      const { rows } = await db.query(
        `update scenarios
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
      const { rowCount } = await db.query('delete from scenarios where id = $1', [id]);
      return rowCount > 0;
    },
  };
}
