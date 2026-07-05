import http from 'node:http';
import pg from 'pg';
import { Server as SocketIOServer } from 'socket.io';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { seedCoach } from './seed.js';
import { verifyToken } from './auth/tokens.js';

const config = loadConfig();
if (!config.databaseUrl) {
  throw new Error('Missing required env var: SUPABASE_DB_URL');
}

const db = new pg.Pool({ connectionString: config.databaseUrl });
const seeded = await seedCoach(db, config);

const app = createApp({ db, config });
const server = http.createServer(app);

// Sockets in M1: trivial authenticated connection ping only (M1 §1).
const io = new SocketIOServer(server, {
  cors: { origin: config.clientOrigin },
});
io.use((socket, next) => {
  try {
    socket.player = verifyToken(socket.handshake.auth?.token, config);
    next();
  } catch {
    next(new Error('unauthenticated'));
  }
});
io.on('connection', (socket) => {
  socket.on('ping', (cb) => {
    if (typeof cb === 'function') cb({ pong: true });
  });
});

server.listen(config.port, () => {
  console.log(
    `FeltSide server on :${config.port}` +
    (seeded ? ` (coach seeded: ${seeded.email})` : '')
  );
});
