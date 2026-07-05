import express from 'express';
import { buildAuthMiddleware } from './auth/middleware.js';
import { buildPlayersRepo } from './repos/playersRepo.js';
import { buildBankrollRepo } from './repos/bankrollRepo.js';
import { buildTablesRepo } from './repos/tablesRepo.js';
import { buildRecordingRepo } from './repos/recordingRepo.js';
import { TableService } from './tables/TableService.js';
import { buildAuthRoutes } from './routes/auth.js';
import { buildPlayersRoutes } from './routes/players.js';
import { buildBankrollRoutes } from './routes/bankroll.js';
import { buildTablesRoutes } from './routes/tables.js';

export function createApp({ db, config, tableService = null, tableTimers = {}, cardSourceFactory = undefined }) {
  const playersRepo = buildPlayersRepo(db);
  const bankrollRepo = buildBankrollRepo(db);
  const tablesRepo = buildTablesRepo(db);
  const recordingRepo = buildRecordingRepo(db);
  const { requireAuth, requireCoach } = buildAuthMiddleware({ config, playersRepo });

  const service = tableService ?? new TableService({
    repos: { tablesRepo, bankrollRepo, recordingRepo, playersRepo },
    timers: tableTimers,
    cardSourceFactory,
  });

  const app = express();
  app.use(express.json());

  // Dev CORS for the Vite client (same-origin in production).
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', config.clientOrigin);
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use('/api/auth', buildAuthRoutes({ playersRepo, requireAuth, config }));
  app.use('/api/players', buildPlayersRoutes({ playersRepo, bankrollRepo, requireAuth, requireCoach }));
  app.use('/api/bankroll', buildBankrollRoutes({ playersRepo, bankrollRepo, requireAuth, requireCoach }));
  app.use('/api/tables', buildTablesRoutes({ tablesRepo, tableService: service, requireAuth }));

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: 'internal_error' });
  });

  app.locals.repos = { playersRepo, bankrollRepo, tablesRepo, recordingRepo };
  app.locals.tableService = service;
  return app;
}
