export function buildTablesRepo(db) {
  return {
    async list() {
      const { rows } = await db.query(
        `select id, mode, status, created_by, config, crm_entry_id,
                created_at, updated_at
           from tables
          where status <> 'completed'
          order by created_at`
      );
      return rows;
    },
  };
}
