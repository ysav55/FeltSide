import pg from 'pg';
import 'dotenv/config';
import { migrate } from '../src/db/migrate.js';

const url = process.env.SUPABASE_DB_URL;
if (!url) throw new Error('Missing required env var: SUPABASE_DB_URL');

const db = new pg.Pool({ connectionString: url });
const applied = await migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Up to date.');
await db.end();
