import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import logger from './utils/logger.ts';
import type { ChatMessage } from '../../shared/types.ts';

const PORT = 3000;

logger();
const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

app.get('/', (req, res) => {
  res.send('<h1>Hello world</h1>');
});

io.on('connection', (socket) => {
  console.log('connected');
  socket.on('message', (msg) => {
    console.log(`received message: ${msg}`);
    const message: ChatMessage = {
      timestamp: Date.now(),
      senderId: socket.id, // TODO 用户id
      text: msg,
    };
    io.emit('message', message);
  });
  socket.on('disconnect', () => {
    console.log('disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
