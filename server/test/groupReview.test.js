import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { io as ioClient } from 'socket.io-client';
import { testApp, TEST_CONFIG, loginToken } from './helpers.js';
import { attachSockets } from '../src/socket.js';
import { signToken } from '../src/auth/tokens.js';

// M6 §6 acceptance — group transition across TWO parallel tables: the
// coach moves every connected player at a table into the same review; the
// other table is unaffected; "Back to Play" returns everyone.

const servers = [];
const clients = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) s.close();
});

function connect(port, token) {
  const sock = ioClient(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'] });
  clients.push(sock);
  return sock;
}
const once = (sock, event) => new Promise((resolve) => sock.once(event, resolve));
const cmd = (sock, tableId, command, payload = {}) =>
  new Promise((resolve) => sock.emit('coach:command', { tableId, command, payload }, resolve));

async function checkDown(runtime) {
  const { engine } = runtime;
  while (engine.isHandRunning()) {
    const idx = engine.toAct;
    if (idx === null) { await new Promise((r) => setTimeout(r, 3)); continue; }
    const pid = engine.seats[idx].playerId;
    const legal = engine.legalActions(pid);
    await runtime.act(pid, legal.check ? { type: 'check' } : { type: 'call' });
  }
  await runtime._enqueue(async () => {});
}

describe('M6 §6 — group transition (two parallel tables)', () => {
  it('coach sends one table to review; only that table follows; back-to-play returns', async () => {
    const { app, db, repos, tableService, coach } = await testApp();
    const server = http.createServer(app);
    attachSockets({ httpServer: server, config: TEST_CONFIG, tableService });
    await new Promise((r) => server.listen(0, r));
    servers.push(server);
    const port = server.address().port;

    const coachToken = signToken({ id: coach.id, role: 'coach' }, TEST_CONFIG);

    // Two coached tables, one player each (kept minimal; the room is what matters).
    const mk = async (email) => {
      const p = await repos.playersRepo.create({ displayName: email, email, passwordHash: 'x', role: 'player' });
      const token = signToken({ id: p.id, role: 'player' }, TEST_CONFIG);
      return { p, token };
    };
    const a = await mk('a@t.io');
    const b = await mk('b@t.io');

    const t1 = await tableService.createCoachedTable({ coach, smallBlind: 50, bigBlind: 100, tableSize: 6 });
    const t2 = await tableService.createCoachedTable({ coach, smallBlind: 50, bigBlind: 100, tableSize: 6 });
    await t1.join({ player: a.p }); await t1.join({ player: coach });
    await t2.join({ player: b.p }); await t2.join({ player: coach });

    // Record a hand at each table so there is something to review.
    await t1.deal(); await checkDown(t1);
    const hand1 = (await db.query('select h.id from hands h join sessions s on s.id=h.session_id where s.table_id=$1 order by h.played_at desc limit 1', [t1.tableId])).rows[0].id;
    await t2.deal(); await checkDown(t2);

    // Sockets: player A + coach in room 1; player B in room 2.
    const coachSock = connect(port, coachToken);
    const aSock = connect(port, a.token);
    const bSock = connect(port, b.token);
    await Promise.all([once(coachSock, 'connect'), once(aSock, 'connect'), once(bSock, 'connect')]);

    await new Promise((resolve) => aSock.emit('table:enter', { tableId: t1.tableId }, resolve));
    await new Promise((resolve) => bSock.emit('table:enter', { tableId: t2.tableId }, resolve));
    await new Promise((resolve) => coachSock.emit('table:observe', { tableId: t1.tableId }, resolve));

    // B must NOT receive table 1's review; assert by racing against a timeout.
    let bGotReview = null;
    bSock.on('table:group_review', (s) => { bGotReview = s; });

    // Coach: "Go to Review" on table 1 → player A enters the review.
    const aReview = once(aSock, 'table:group_review');
    const enter = await cmd(coachSock, t1.tableId, 'review:enter', { hand_id: hand1, cursor: 0 });
    expect(enter.ok).toBe(true);
    const payloadA = await aReview;
    expect(payloadA.handId).toBe(hand1);
    expect(payloadA.cursor).toBe(0);
    // Open-kimono: the review payload carries every hole card.
    expect(payloadA.hand.participants.every((p) => Array.isArray(p.holeCards))).toBe(true);
    expect(t1.groupReview).not.toBeNull();
    expect(t2.groupReview).toBeNull(); // parallel table untouched

    // Synced navigation: coach steps forward → A follows.
    const aNav = once(aSock, 'table:group_review');
    await cmd(coachSock, t1.tableId, 'review:nav', { cursor: 2 });
    expect((await aNav).cursor).toBe(2);

    // Back to Play → A leaves the review (null payload).
    const aExit = once(aSock, 'table:group_review');
    await cmd(coachSock, t1.tableId, 'review:exit');
    expect(await aExit).toBeNull();
    expect(t1.groupReview).toBeNull();

    // Table 2's player never saw table 1's review.
    await new Promise((r) => setTimeout(r, 40));
    expect(bGotReview).toBeNull();
  }, 30_000);
});
