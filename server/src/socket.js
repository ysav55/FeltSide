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
