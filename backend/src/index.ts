import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import type { DefaultEventsMap } from 'socket.io';
import logger from './utils/logger.ts';
import { findOrCreateUser, findUserById } from './db.ts';
import type {
  ChatMessage,
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from '../../shared/types.ts';

const PORT = 3000;
const ORIGIN = 'http://localhost:5173';
const MAX_USERNAME_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 2000;

logger();
const app = express();
const server = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>(server, {
  cors: {
    origin: ORIGIN,
    methods: ['GET', 'POST'],
  },
});

// CORS 必须放在 express.json() 之前：保证后面解析/校验失败返回的 400 也带上 CORS 头，
// 否则浏览器端只能看到 "Failed to fetch"，看不到真正的错误信息
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204); // 预检直接结束，不进入路由
    return;
  }
  next();
});
app.use(express.json());

app.get('/', (_req, res) => {
  res.send('<h1>Hello world</h1>');
});

// find-or-create: 用户名已存在返回 200，不存在则新注册并返回 201
app.post('/api/users', (req, res) => {
  const raw: unknown = (req.body as { username?: unknown } | undefined)?.username;
  if (typeof raw !== 'string') {
    res.status(400).json({ error: '请求体必须为 { "username": "..." }' });
    return;
  }
  const username = raw.trim();
  if (!username) {
    res.status(400).json({ error: '用户名不能为空' });
    return;
  }
  if (username.length > MAX_USERNAME_LENGTH) {
    res.status(400).json({ error: `用户名不能超过 ${MAX_USERNAME_LENGTH} 个字符` });
    return;
  }
  const { user, created } = findOrCreateUser(username);
  res.status(created ? 201 : 200).json(user);
});

// 按 id 查询用户
app.get('/api/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: '无效的用户 id' });
    return;
  }
  const user = findUserById(id);
  if (!user) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  res.json(user);
});

// 兜底错误处理中间件，保证错误响应也是 JSON
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof SyntaxError) {
    res.status(400).json({ error: '请求体不是合法 JSON' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});



// 连接握手校验：客户端必须带 auth: { userId }，且该用户在库中存在
io.use((socket, next) => {
  const raw: unknown = socket.handshake.auth?.userId;
  const userId = typeof raw === 'number' ? raw : Number(raw); // 兼容字符串形式
  if (!Number.isInteger(userId) || userId <= 0) {
    next(new Error('无效的用户 id'));
    return;
  }
  const user = findUserById(userId);
  if (!user) {
    next(new Error('用户不存在'));
    return;
  }
  socket.data.user = user;
  next();
});

// socket 实时聊天
io.on('connection', (socket) => {
  const user = socket.data.user;
  console.log(`connected: ${user.username}(${user.id})`);

  socket.on('message', (text) => {
    if (typeof text !== 'string') return; // 防异常客户端
    const body = text.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!body) return;
    console.log(`received message from ${user.username}: ${body}`);
    const message: ChatMessage = {
      timestamp: Date.now(),
      senderId: user.id,
      username: user.username,
      text: body,
    };
    io.emit('message', message);
  });

  socket.on('disconnect', () => {
    console.log(`disconnected: ${user.username}(${user.id})`);
  });
});

server.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
