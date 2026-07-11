import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'supabase', 'migrations'
);

/**
 * Applies append-only SQL migrations in filename order.
 * `db` is anything with .query(text, params) → { rows } (pg Pool or PGlite).
 */
export async function migrate(db, dir = DEFAULT_DIR) {
  await db.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await db.query('select name from schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const newlyApplied = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    await db.query('begin');
    try {
      // Multi-statement scripts: PGlite needs exec(); pg accepts query().
      if (typeof db.exec === 'function') await db.exec(sql);
      else await db.query(sql);
      await db.query('insert into schema_migrations (name) values ($1)', [file]);
      await db.query('commit');
    } catch (err) {
      await db.query('rollback');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
    newlyApplied.push(file);
  }
  return newlyApplied;
}
