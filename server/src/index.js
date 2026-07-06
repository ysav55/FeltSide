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

// RUNTIME §3 backstop: scheduled-never-started tables removed 24h after
// scheduled start — checked at boot and hourly (the CRM reconcile also
// prunes on every push).
const tablesRepo = app.locals.repos.tablesRepo;
const pruneStale = () =>
  tablesRepo
    .pruneStaleScheduled(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .catch(() => {});
await pruneStale();
setInterval(pruneStale, 60 * 60 * 1000).unref();

server.listen(config.port, () => {
  console.log(
    `FeltSide server on :${config.port}` +
    (seeded ? ` (coach seeded: ${seeded.email})` : '') +
    (recovered ? ` (${recovered} table(s) recovered)` : '')
  );
});

// Fly scale-to-zero (RUNTIME §1): stacks are snapshotted after every
// completed hand, so a machine stop loses at most the in-flight hand —
// voided by design. On stop: freeze timers (no mid-shutdown mutations),
// close, exit; recover() rebuilds every table on the next boot.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    for (const runtime of tableService.runtimes.values()) runtime.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
