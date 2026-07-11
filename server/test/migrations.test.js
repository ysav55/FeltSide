import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/db/migrate.js';

describe('migrations', () => {
  it('apply cleanly on a fresh database and are idempotent', async () => {
    const db = new PGlite();
    const applied = await migrate(db);
    expect(applied).toEqual([
      '0001_players.sql',
      '0002_bankroll.sql',
      '0003_tables.sql',
      '0004_recording.sql',
      '0005_export_sync.sql',
      '0006_coached_analyzers.sql',
      '0007_review_annotations.sql',
      '0008_tournaments.sql',
    ]);

    const again = await migrate(db);
    expect(again).toEqual([]);

    const { rows } = await db.query(`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name
    `);
    const names = rows.map((r) => r.table_name);
    for (const t of ['players', 'bankroll_accounts', 'bankroll_transactions', 'tables']) {
      expect(names).toContain(t);
    }
  });
});
