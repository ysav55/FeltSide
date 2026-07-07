/**
 * Grand-E2E engine host (M4/M5 Part C). Boots the REAL engine (full app +
 * sockets + export/sync API) on an in-process Postgres, scripts the story
 * the CRM will poll, then stays up serving /export/v1 and /sync/v1:
 *
 *   - Dana (CRM-linked) + Ben (unlinked)
 *   - one uncoached cash session: 6 checked-down RNG hands (stat food)
 *   - one coached session, 3-handed, two hands:
 *       hand 1: Ben opens AQo on the BTN (in-chart); Dana folds ATo in the
 *               SB → SB_OVERFOLD (deliberately-unmapped mistake)
 *       hand 2: Dana opens 72o on the BTN → OPEN_TOO_LOOSE (the deliberate
 *               chart deviation, mapped to open_too_loose) + a live coach tag
 *
 * Run:  node scripts/e2e-server.js   (E2E_PORT to override, default 3999)
 * Key:  e2e-test-key
 */

import http from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { seedCoach } from '../src/seed.js';
import { attachSockets } from '../src/socket.js';
import { hashPassword } from '../src/auth/passwords.js';

const PORT = Number(process.env.E2E_PORT ?? 3999);
export const DANA_CRM_ID = 'stu_01HZFELTSIDEE2EDANA0000001';

const config = {
  port: PORT,
  exportApiKey: process.env.E2E_EXPORT_KEY ?? 'e2e-test-key',
  publicBaseUrl: `http://127.0.0.1:${PORT}`,
  jwtSecret: 'e2e-secret',
  jwtExpiresIn: '1h',
  coachEmail: 'jo@e2e.local',
  coachInitialPassword: 'e2e-coach-pass-1',
  coachDisplayName: 'Jo',
  clientOrigin: '*',
};

const db = new PGlite();
await migrate(db);
const coach = await seedCoach(db, config);
const app = createApp({
  db, config,
  tableTimers: { interHandMs: 10, actionMs: 60_000, disconnectGraceMs: 60_000, retentionMs: 60_000, idleCloseMs: 600_000 },
});
const service = app.locals.tableService;
const repos = app.locals.repos;

async function mkPlayer(name, email, crmId = null) {
  const p = await repos.playersRepo.create({
    displayName: name, email, passwordHash: await hashPassword('e2e-pw-123456'), role: 'player',
  });
  await repos.bankrollRepo.createAccount(p.id);
  await repos.bankrollRepo.applyTransaction({
    playerId: p.id, type: 'coach_adjustment', amount: 100_000, note: 'e2e roll',
  });
  if (crmId) await repos.playersRepo.setCrmStudentId(p.id, crmId);
  return repos.playersRepo.findById(p.id);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Check/call every decision until the running hand completes. */
async function checkDown(runtime) {
  const { engine } = runtime;
  const start = Date.now();
  while (engine.isHandRunning()) {
    if (Date.now() - start > 10_000) throw new Error('checkDown stuck');
    const idx = engine.toAct;
    if (idx === null) { await sleep(3); continue; }
    const pid = engine.seats[idx].playerId;
    const legal = engine.legalActions(pid);
    await runtime.act(pid, legal.check ? { type: 'check' } : { type: 'call' });
  }
  await runtime._enqueue(async () => {});
}

const dana = await mkPlayer('Dana K', 'dana@e2e.local', DANA_CRM_ID);
const ben = await mkPlayer('Ben R', 'ben@e2e.local');

// ── Story 1: uncoached cash, 6 RNG hands ─────────────────────────────────
{
  const runtime = await service.createTable({
    creator: dana, smallBlind: 50, bigBlind: 100, tableSize: 6, name: 'E2E cash',
  });
  await runtime.join({ player: dana, buyIn: 10_000 });
  await runtime.join({ player: ben, buyIn: 10_000 });
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (runtime.engine.isHandRunning()) { clearInterval(check); resolve(); }
      }, 3);
    });
    await checkDown(runtime);
  }
  await service.closeTable(runtime.tableId, 'e2e_done');
}

// ── Story 2: coached session — SB_OVERFOLD + the deliberate deviation ────
{
  const runtime = await service.createCoachedTable({
    coach, smallBlind: 50, bigBlind: 100, tableSize: 6, name: 'E2E lesson',
  });
  runtime.setOpenSeating(true);
  await runtime.join({ player: ben, seatIndex: 0 });
  await runtime.join({ player: dana, seatIndex: 1 });
  await runtime.join({ player: coach, seatIndex: 2 });

  const act = (pid, a) => runtime.act(pid, a);

  // Hand 1 — button seat 0: Ben BTN (AQo, chart open), Dana SB (ATo → the
  // SB-defend chart says defend vs BTN; her fold is SB_OVERFOLD, unmapped).
  runtime.setHoleSlot(ben.id, { mode: 'cards', cards: ['Ah', 'Qd'] });
  runtime.setHoleSlot(dana.id, { mode: 'cards', cards: ['As', 'Th'] });
  runtime.setHoleSlot(coach.id, { mode: 'cards', cards: ['8h', '3c'] });
  await runtime.deal();
  await act(ben.id, { type: 'raise', amount: 250 });
  await act(dana.id, { type: 'fold' });
  await act(coach.id, { type: 'fold' });
  await runtime._enqueue(async () => {});

  // Hand 2 — button rotates to seat 1: Dana BTN opens 7-2o → OPEN_TOO_LOOSE.
  runtime.setHoleSlot(dana.id, { mode: 'cards', cards: ['7h', '2d'] });
  runtime.setHoleSlot(ben.id, { mode: 'cards', cards: ['9h', '4d'] });
  runtime.setHoleSlot(coach.id, { mode: 'cards', cards: ['8c', '3d'] });
  await runtime.deal();
  await runtime.coachTag({ tag: 'talked through this open live', playerId: dana.id });
  await act(dana.id, { type: 'raise', amount: 250 });
  await act(coach.id, { type: 'fold' });
  await act(ben.id, { type: 'fold' });
  await runtime._enqueue(async () => {});

  await service.closeTable(runtime.tableId, 'e2e_done');
}

// ── Serve, and watch for the CRM's reverse push (CONTRACT §8) ────────────
const server = http.createServer(app);
attachSockets({ httpServer: server, config, tableService: service });
server.listen(PORT, () => {
  console.log(JSON.stringify({
    ready: true,
    port: PORT,
    danaCrmId: DANA_CRM_ID,
    players: { dana: dana.id, ben: ben.id, coach: coach.id },
    story: { uncoachedHands: 6, coachedHands: 2 },
  }));
});

setInterval(async () => {
  const rows = await repos.tablesRepo.listByCrmEntry();
  const scheduled = rows.filter((t) => t.status === 'scheduled');
  if (scheduled.length > 0) {
    console.log(JSON.stringify({
      reverse_channel: 'lesson_synced',
      entries: scheduled.map((t) => ({ crm_entry_id: t.crm_entry_id, title: t.config?.name })),
    }));
  }
}, 1000).unref();
