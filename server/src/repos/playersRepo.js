const PUBLIC_COLUMNS = `id, display_name, email, role, crm_student_id,
  must_change_password, status, owner_coach_id, created_at, updated_at`;

export function toPublicPlayer(row) {
  if (!row) return null;
  const { password_hash, ...rest } = row;
  return rest;
}

export function buildPlayersRepo(db) {
  return {
    async findById(id) {
      const { rows } = await db.query(
        'select * from players where id = $1', [id]
      );
      return rows[0] || null;
    },

    async findByEmail(email) {
      const { rows } = await db.query(
        'select * from players where lower(email) = lower($1)', [email]
      );
      return rows[0] || null;
    },

    async countCoaches() {
      const { rows } = await db.query(
        "select count(*)::int as n from players where role = 'coach'"
      );
      return rows[0].n;
    },

    async create({ displayName, email, passwordHash, role, ownerCoachId = null, mustChangePassword = false }) {
      const { rows } = await db.query(
        `insert into players
           (display_name, email, password_hash, role, owner_coach_id, must_change_password)
         values ($1, $2, $3, $4, $5, $6)
         returning *`,
        [displayName, email, passwordHash, role, ownerCoachId, mustChangePassword]
      );
      return rows[0];
    },

    async list() {
      const { rows } = await db.query(
        `select ${PUBLIC_COLUMNS} from players order by created_at`
      );
      return rows;
    },

    async setStatus(id, status) {
      const { rows } = await db.query(
        `update players set status = $2, updated_at = now()
         where id = $1 returning *`,
        [id, status]
      );
      return rows[0] || null;
    },

    async setCrmStudentId(id, crmStudentId) {
      const { rows } = await db.query(
        `update players set crm_student_id = $2, updated_at = now()
         where id = $1 returning *`,
        [id, crmStudentId]
      );
      return rows[0] || null;
    },

    async setPassword(id, passwordHash, mustChangePassword) {
      const { rows } = await db.query(
        `update players
           set password_hash = $2, must_change_password = $3, updated_at = now()
         where id = $1 returning *`,
        [id, passwordHash, mustChangePassword]
      );
      return rows[0] || null;
    },
  };
}
