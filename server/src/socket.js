import { Server as SocketIOServer } from 'socket.io';
import { verifyToken } from './auth/tokens.js';

/**
 * Socket layer for live play. Auth on handshake (JWT); each seated player
 * joins their table's room; gameplay actions flow through the runtime's
 * serialized queue. Reconnect identity is by player account, never socket
 * id (RUNTIME §2).
 */
export function attachSockets({ httpServer, config, tableService }) {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: config.clientOrigin },
  });

  io.use((socket, next) => {
    try {
      const payload = verifyToken(socket.handshake.auth?.token, config);
      socket.playerId = payload.sub;
      socket.role = payload.role;
      next();
    } catch {
      next(new Error('unauthenticated'));
    }
  });

  // Fan runtime events out to table rooms.
  tableService.emit = (event, payload) => {
    const room = `table:${payload.tableId}`;
    if (event === 'state') {
      // Per-viewer redaction: each socket gets its own view.
      for (const [, socket] of io.of('/').sockets) {
        if (socket.rooms.has(room)) {
          const runtime = tableService.get(payload.tableId);
          if (runtime) socket.emit('table:state', runtime.publicState(socket.playerId));
        }
      }
    } else if (event === 'coach_state' || event === 'coach_awaiting_deal') {
      // Coach-only payloads (dealing panel, assigned cards) — the
      // visibility rule is enforced HERE, per socket role, server-side.
      const runtime = tableService.get(payload.tableId);
      for (const [, socket] of io.of('/').sockets) {
        if (socket.rooms.has(room) && socket.role === 'coach' && runtime?.coachState) {
          socket.emit(`table:${event}`, event === 'coach_state'
            ? runtime.coachState()
            : payload);
        }
      }
    } else if (event === 'group_review') {
      // Group transition (M6 §6): the whole room follows the coach into (or
      // out of) the review. Open-kimono review payload to every connected
      // player at THIS table only.
      const runtime = tableService.get(payload.tableId);
      const state = runtime?.groupReviewState ? runtime.groupReviewState() : null;
      io.to(room).emit('table:group_review', state);
    } else {
      io.to(room).emit(`table:${event}`, payload);
    }
  };

  const connectionsPerPlayer = new Map(); // playerId → count

  io.on('connection', (socket) => {
    socket.on('ping', (cb) => { if (typeof cb === 'function') cb({ pong: true }); });

    socket.on('table:enter', ({ tableId } = {}, cb) => {
      const runtime = tableService.get(tableId);
      const seat = runtime && !runtime.closed && runtime.engine.findSeat(socket.playerId);
      if (!seat) return cb?.({ error: 'not_seated' });
      socket.join(`table:${tableId}`);
      socket.tableId = tableId;
      const count = (connectionsPerPlayer.get(socket.playerId) || 0) + 1;
      connectionsPerPlayer.set(socket.playerId, count);
      if (count === 1) runtime.playerConnected(socket.playerId);
      cb?.({ table: runtime.publicState(socket.playerId) });
    });

    socket.on('table:action', async ({ tableId, action, amount } = {}, cb) => {
      const runtime = tableService.get(tableId);
      if (!runtime) return cb?.({ error: 'not_found' });
      try {
        await runtime.act(socket.playerId, { type: action, amount });
        cb?.({ ok: true });
      } catch (err) {
        cb?.({ error: err.code || 'action_failed' });
      }
    });

    socket.on('table:sitout', async ({ tableId, sit_out: sitOut } = {}, cb) => {
      const runtime = tableService.get(tableId);
      if (!runtime) return cb?.({ error: 'not_found' });
      try {
        await runtime.sitOut(socket.playerId, Boolean(sitOut));
        cb?.({ ok: true });
      } catch (err) {
        cb?.({ error: err.code || 'sitout_failed' });
      }
    });

    // ── Coach commands (M4) — role-gated server-side ────────────────────
    // One handler per command keeps the guard in exactly one place.
    const coachCommands = {
      'panel:hole':   (rt, p) => rt.setHoleSlot(p.player_id, p.slot ?? null),
      'panel:board':  (rt, p) => rt.setBoardSlot(p.index, p.card ?? null),
      'panel:policy': (rt, p) => rt.setStreetPolicy(p.street, p.policy),
      'deal':         (rt) => rt.deal(),
      'redeal':       (rt) => rt.redeal(),
      'provide':      (rt, p) => rt.provideStreet(p.cards ?? null),
      'rng-rest':     (rt) => rt.rngRest(),
      'pause':        (rt, p) => rt.pause(Boolean(p.paused)),
      'undo':         (rt) => rt.undo(),
      'rollback':     (rt) => rt.rollbackStreet(),
      'force-street': (rt) => rt.forceStreet(),
      'award-pot':    (rt, p) => rt.awardPot(p.player_id),
      'stack':        (rt, p) => rt.setStack(p.player_id, p.stack),
      'blinds':       (rt, p) => rt.setBlinds(p.small_blind, p.big_blind),
      'tag':          (rt, p) => rt.coachTag({
        tag: p.tag, playerId: p.player_id ?? null, actionSeq: p.action_seq ?? null,
      }),
      'open-seating': (rt, p) => rt.setOpenSeating(Boolean(p.open)),
      'save-scenario': (rt, p, sock) => rt.saveScenario({
        name: String(p.name ?? '').trim().slice(0, 120) || 'Untitled',
        description: p.description ?? null, createdBy: sock.playerId,
      }),
      'load-playlist': (rt, p) => rt.loadPlaylist(p.playlist_id),
      'next-drill':   (rt) => rt.nextDrill(),
      'state':        (rt) => rt.coachState(),
      // ── M6 review / branch / group transition ───────────────────────
      'branch':       async (rt, p) => {
        const hand = await tableService.repos.handReadRepo.getHandDetail(p.hand_id);
        if (!hand) throw new Error('hand_not_found');
        return rt.branchFromHand(hand, p.cursor ?? 0);
      },
      'unbranch':     (rt) => rt.unbranchFromHand(),
      'review:enter': async (rt, p) => {
        const hand = await tableService.repos.handReadRepo.getHandDetail(p.hand_id);
        if (!hand) throw new Error('hand_not_found');
        rt.enterGroupReview(hand, p.cursor ?? 0);
        return { entered: true };
      },
      'review:nav':   (rt, p) => { rt.navGroupReview(p.cursor ?? 0); return { cursor: p.cursor ?? 0 }; },
      'review:exit':  (rt) => { rt.exitGroupReview(); return { exited: true }; },
    };

    socket.on('coach:command', async ({ tableId, command, payload = {} } = {}, cb) => {
      if (socket.role !== 'coach') return cb?.({ error: 'coach_only' });
      const runtime = tableService.get(tableId);
      if (!runtime || runtime.closed) return cb?.({ error: 'not_found' });
      if (!runtime.coachState) return cb?.({ error: 'not_coached' });
      const handler = coachCommands[command];
      if (!handler) return cb?.({ error: 'unknown_command' });
      try {
        const result = await handler(runtime, payload, socket);
        cb?.({ ok: true, result: result ?? null, coach: runtime.coachState() });
      } catch (err) {
        cb?.({ error: err.code || err.message || 'command_failed' });
      }
    });

    // Coach may enter any table room as an observer (spectate is a state,
    // not a role — PRD §2).
    socket.on('table:observe', ({ tableId } = {}, cb) => {
      if (socket.role !== 'coach') return cb?.({ error: 'coach_only' });
      const runtime = tableService.get(tableId);
      if (!runtime || runtime.closed) return cb?.({ error: 'not_found' });
      socket.join(`table:${tableId}`);
      socket.tableId = tableId;
      cb?.({
        table: runtime.publicState(socket.playerId),
        ...(runtime.coachState ? { coach: runtime.coachState() } : {}),
      });
    });

    socket.on('disconnect', () => {
      if (!socket.tableId) return;
      const count = (connectionsPerPlayer.get(socket.playerId) || 1) - 1;
      if (count <= 0) {
        connectionsPerPlayer.delete(socket.playerId);
        const runtime = tableService.get(socket.tableId);
        if (runtime && !runtime.closed) runtime.playerDisconnected(socket.playerId);
      } else {
        connectionsPerPlayer.set(socket.playerId, count);
      }
    });
  });

  return io;
}
