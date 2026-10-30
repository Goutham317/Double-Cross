
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { RoomManager } from './rooms.js';

const app = express();

app.use(cors());

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'double-cross-server',
  });
});

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
  },
});

const rooms = new RoomManager(io);

io.on('connection', socket => {
  rooms.register(socket);
});

const port = Number(process.env.PORT ?? 3001);

httpServer.listen(port, '127.0.0.1', () => {
  console.log(
    `DOUBLE CROSS server listening on http://localhost:${port}`,
  );
});
