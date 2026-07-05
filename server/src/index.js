import http from 'node:http';
import pg from 'pg';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { seedCoach } from './seed.js';
import { attachSockets } from './socket.js';

const config = loadConfig();
if (!config.databaseUrl) {
  throw new Error('Missing required env var: SUPABASE_DB_URL');
}

const db = new pg.Pool({ connectionString: config.databaseUrl });
const seeded = await seedCoach(db, config);

const app = createApp({ db, config });
const tableService = app.locals.tableService;

const server = http.createServer(app);
attachSockets({ httpServer: server, config, tableService });

// RUNTIME §1 boot recovery: rebuild non-completed tables from snapshots;
// any in-flight hand at crash time is voided by construction.
const recovered = await tableService.recover();

server.listen(config.port, () => {
  console.log(
    `FeltSide server on :${config.port}` +
    (seeded ? ` (coach seeded: ${seeded.email})` : '') +
    (recovered ? ` (${recovered} table(s) recovered)` : '')
  );
});
