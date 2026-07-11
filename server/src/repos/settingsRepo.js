/**
 * engine_settings — keyed JSON settings (TAXONOMY §6 analyzer settings
 * live under the 'analyzer' key as coach overrides over the defaults).
 */
export function buildSettingsRepo(db) {
  return {
    async get(key) {
      const { rows } = await db.query(
        'select value from engine_settings where key = $1', [key]
      );
      return rows[0]?.value ?? null;
    },

    async set(key, value) {
      await db.query(
        `insert into engine_settings (key, value, updated_at)
         values ($1, $2, now())
         on conflict (key) do update set value = $2, updated_at = now()`,
        [key, JSON.stringify(value)]
      );
    },
  };
}
