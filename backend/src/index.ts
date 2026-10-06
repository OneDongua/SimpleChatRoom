import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { DefaultEventsMap } from 'socket.io';
import { Server } from 'socket.io';
import logger from './utils/logger.ts';
import {
  addRoomMember,
  createRoom,
  createAnonymousUser,
  createRegisteredUser,
  createSession,
  findUserByTokenHash,
  findUserCredentials,
  findUserById,
  upgradeAnonymousUser,
  getRoomById,
  getRoomPasswordHash,
  isRoomMember,
  listMessages,
  listRoomsForUser,
  listUnreadCounts,
  markRoomRead,
  saveMessage,
} from './db.ts';
import { hashPassword, verifyPassword } from './utils/password.ts';
import type { ClientToServerEvents, ServerToClientEvents, SocketData, User } from '../../shared/types.ts';

const HOST = '0.0.0.0';
const PORT = 3000;
const ORIGIN = '*';  // 开发环境使用
const MAX_USERNAME_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_ROOM_NAME_LENGTH = 32;
const MAX_ROOM_PASSWORD_LENGTH = 64;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const SESSION_DAYS = 30;

logger();
const app = express();
const server = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>(server, {
  cors: {
    origin: ORIGIN,
    methods: ['GET', 'POST'],
  },
});

/** 把未知值（数字或数字字符串）解析为正整数；其余（空串、NaN、小数、负数、数组等）返回 undefined */
function readPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** socket.io 频道名：消息只广播给频道内（即房内）的连接 */
const roomChannel = (roomId: number) => `room:${roomId}`;

/** socket.io 频道名：每个用户一个频道（该用户所有标签页的连接都在里面），用于同步未读数 */
const userChannel = (userId: number) => `user:${userId}`;

/**
 * 房间落新消息后同步未读数：频道内（正在看该房）的成员先把已读位推进到最新，
 * 再给每个成员推送其真实未读数（在看的人算出来自然是 0）。
 * 不阻塞消息 ack，失败只记日志。
 * @param channel - 房间频道名（room:<id>）。
 * @param roomId - 房间 id。
 */
async function notifyUnread(channel: string, roomId: number): Promise<void> {
  try {
    // 单机模式下 fetchSockets 返回的就是本进程的真实 Socket，data 即握手时写入的 SocketData
    const sockets = await io.in(channel).fetchSockets();
    const present = new Set(sockets.map((s) => s.data.user.id));
    for (const userId of present) markRoomRead(roomId, userId);
    for (const { userId, unreadCount } of listUnreadCounts(roomId)) {
      io.to(userChannel(userId)).emit('unread', { roomId, unreadCount });
    }
  } catch (err) {
    console.error('未读数广播失败', err);
  }
}

// CORS 必须放在 express.json() 之前：保证后面解析/校验失败返回的 400 也带上 CORS 头，
// 否则浏览器端只能看到 "Failed to fetch"，看不到真正的错误信息
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

function issueToken(user: User): string {
  const token = randomBytes(32).toString('hex');
  createSession(user.id, createHash('sha256').update(token).digest('hex'), Date.now() + SESSION_DAYS * 86400000);
  return token;
}

function bearerToken(req: Request): string | undefined {
  const value = req.header('authorization');
  return value?.startsWith('Bearer ') ? value.slice(7).trim() : undefined;
}

function authenticatedUser(req: Request, res: Response): User | undefined {
  const token = bearerToken(req);
  const user = token ? findUserByTokenHash(createHash('sha256').update(token).digest('hex')) : undefined;
  if (!user || user.status === 'banned') {
    res.status(401).json({ error: '未登录或登录已失效' });
    return undefined;
  }
  return user;
}

function readUsername(body: unknown): string | undefined {
  const raw = (body as { username?: unknown } | undefined)?.username;
  if (typeof raw !== 'string') return undefined;
  const username = raw.trim();
  return username && username.length <= MAX_USERNAME_LENGTH ? username : undefined;
}

app.post('/api/auth/anonymous', (_req, res) => {
  const username = `游客_${randomBytes(3).toString('hex').toUpperCase()}`;
  const user = createAnonymousUser(username);
  res.status(201).json({ user, token: issueToken(user) });
});

app.post('/api/auth/register', (req, res) => {
  const username = readUsername(req.body);
  const password = (req.body as { password?: unknown } | undefined)?.password;
  if (!username || typeof password !== 'string' || password.length < 6 || password.length > 128) {
    res.status(400).json({ error: '用户名长度不超过 32 个字符，密码长度需为 6-128 个字符' });
    return;
  }
  if (findUserCredentials(username)) {
    res.status(409).json({ error: '用户名已存在' });
    return;
  }
  const user = createRegisteredUser(username, hashPassword(password));
  res.status(201).json({ user, token: issueToken(user) });
});

app.post('/api/auth/login', (req, res) => {
  const username = readUsername(req.body);
  const password = (req.body as { password?: unknown } | undefined)?.password;
  const credentials = username ? findUserCredentials(username) : undefined;
  if (!credentials || !credentials.passwordHash || typeof password !== 'string' || !verifyPassword(password, credentials.passwordHash)) {
    res.status(401).json({ error: '用户名或密码错误' });
    return;
  }
  if (credentials.user.status === 'banned') {
    res.status(403).json({ error: '该用户已被封禁' });
    return;
  }
  res.json({ user: credentials.user, token: issueToken(credentials.user) });
});

app.get('/api/auth/me', (req, res) => {
  const user = authenticatedUser(req, res);
  if (user) res.json({ user });
});

app.post('/api/auth/upgrade', (req, res) => {
  const user = authenticatedUser(req, res);
  if (!user) return;
  if (user.status !== 'anonymous') {
    res.status(400).json({ error: '当前用户不是匿名用户' });
    return;
  }
  const username = readUsername(req.body);
  const password = (req.body as { password?: unknown } | undefined)?.password;
  if (!username || typeof password !== 'string' || password.length < 6 || password.length > 128) {
    res.status(400).json({ error: '用户名长度不超过 32 个字符，密码长度需为 6-128 个字符' });
    return;
  }
  if (findUserCredentials(username)) {
    res.status(409).json({ error: '用户名已存在' });
    return;
  }
  const upgraded = upgradeAnonymousUser(user.id, username, hashPassword(password));
  if (!upgraded) {
    res.status(409).json({ error: '匿名用户升级失败' });
    return;
  }
  res.json({ user: upgraded, token: issueToken(upgraded) });
});

// 保留旧接口但不再允许“输入用户名即登录”，避免身份冒用。
app.post('/api/users', (_req, res) => {
  res.status(410).json({ error: '请使用匿名进入、注册或登录接口' });
});

// 按 id 查询用户（仅保留兼容接口，不作为鉴权依据）
app.get('/api/users/:id', (req, res) => {
  if (!authenticatedUser(req, res)) return;
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

// 创建聊天室（创建者自动成为成员）；公共房创建成功后广播给所有在线用户。
// 私有房必须设置密码（哈希存储），公共房不允许带密码
app.post('/api/rooms', (req, res) => {
  const user = authenticatedUser(req, res);
  if (!user) return;
  const body = req.body as
    | { name?: unknown; isPublic?: unknown; password?: unknown }
    | undefined;
  if (typeof body?.name !== 'string' || typeof body.isPublic !== 'boolean') {
    res.status(400).json({ error: '请求体必须为 { "name": "...", "isPublic": true }' });
    return;
  }
  const name = body.name.trim();
  if (!name) {
    res.status(400).json({ error: '聊天室名称不能为空' });
    return;
  }
  if (name.length > MAX_ROOM_NAME_LENGTH) {
    res.status(400).json({ error: `聊天室名称不能超过 ${MAX_ROOM_NAME_LENGTH} 个字符` });
    return;
  }
  if (user.status === 'anonymous' && body.isPublic) {
    res.status(403).json({ error: '匿名用户不能创建公共聊天室，请先注册' });
    return;
  }
  // 密码校验放在用户校验之后：只有合法请求才付 scrypt 的计算开销
  let passwordHash: string | null = null;
  if (body.isPublic) {
    if (body.password !== undefined) {
      // 静默忽略会让调用方误以为设了密码，明确拒绝
      res.status(400).json({ error: '公共聊天室不能设置密码' });
      return;
    }
  } else {
    if (typeof body.password !== 'string') {
      res.status(400).json({ error: '私有聊天室必须设置密码' });
      return;
    }
    // 不 trim 后存储：空格是合法密码字符；仅拒绝全空白，避免误触创建"看似无密码"的房
    if (body.password.trim().length === 0) {
      res.status(400).json({ error: '密码不能为空' });
      return;
    }
    if (body.password.length > MAX_ROOM_PASSWORD_LENGTH) {
      res.status(400).json({ error: `密码不能超过 ${MAX_ROOM_PASSWORD_LENGTH} 个字符` });
      return;
    }
    passwordHash = hashPassword(body.password);
  }
  const room = createRoom(name, body.isPublic, user.id, passwordHash);
  if (room.isPublic) io.emit('room:created', room); // 私有房不广播，只有创建者知道
  res.status(201).json({ ...room, isMember: true, unreadCount: 0 }); // 新房无消息，未读恒 0
});

// 当前用户可见的聊天室：公共房全部 + 私有房中已加入的
app.get('/api/rooms', (req, res) => {
  const user = authenticatedUser(req, res);
  if (user) res.json(listRoomsForUser(user.id));
});

// 加入聊天室（幂等）：私有房需提供正确密码；已是成员（含创建者）时直接放行
app.post('/api/rooms/:id/join', (req, res) => {
  const user = authenticatedUser(req, res);
  if (!user) return;
  const roomId = readPositiveInt(req.params.id);
  if (roomId === undefined) {
    res.status(400).json({ error: '无效的房间 id' });
    return;
  }
  const room = getRoomById(roomId);
  if (!room) {
    res.status(404).json({ error: '聊天室不存在' });
    return;
  }
  // 私有房且非成员才验密码；创建者/已成员直接放行（幂等）。
  // 私有房一律有密码（新建时必填，旧测试数据已回填），取不到哈希即拒绝，fail closed
  if (!room.isPublic && !isRoomMember(room.id, user.id)) {
    const rawPassword = (req.body as { password?: unknown } | undefined)?.password;
    if (typeof rawPassword !== 'string' || rawPassword.length === 0) {
      res.status(403).json({ error: '该聊天室需要密码' });
      return;
    }
    const storedHash = getRoomPasswordHash(room.id);
    if (
      typeof storedHash !== 'string' ||
      rawPassword.length > MAX_ROOM_PASSWORD_LENGTH ||
      !verifyPassword(rawPassword, storedHash)
    ) {
      res.status(403).json({ error: '密码错误' });
      return;
    }
  }
  addRoomMember(room.id, user.id);
  // 前端 join 后必然紧接进房（room:enter 会清零并校正），这里的 0 只是过渡值
  res.json({ ...room, isMember: true, unreadCount: 0 });
});

// 历史消息（游标分页：before = 上一页第一条的 id；升序返回）
app.get('/api/rooms/:id/messages', (req, res) => {
  const user = authenticatedUser(req, res);
  if (!user) return;
  const roomId = readPositiveInt(req.params.id);
  if (roomId === undefined) {
    res.status(400).json({ error: '无效的房间 id' });
    return;
  }
  const room = getRoomById(roomId);
  if (!room) {
    res.status(404).json({ error: '聊天室不存在' });
    return;
  }
  const rawBefore = req.query.before;
  let before: number | null = null;
  if (rawBefore !== undefined) {
    const parsedBefore = readPositiveInt(rawBefore);
    if (parsedBefore === undefined) {
      res.status(400).json({ error: '无效的 before 游标' });
      return;
    }
    before = parsedBefore;
  }
  const rawLimit = req.query.limit;
  const limit = rawLimit === undefined ? DEFAULT_PAGE_SIZE : readPositiveInt(rawLimit);
  if (limit === undefined || limit > MAX_PAGE_SIZE) {
    res.status(400).json({ error: `limit 必须在 1-${MAX_PAGE_SIZE} 之间` });
    return;
  }
  if (!room.isPublic && !isRoomMember(room.id, user.id)) {
    res.status(403).json({ error: '你不是该聊天室的成员' });
    return;
  }
  res.json(listMessages(room.id, before, limit));
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

// 连接握手校验：客户端必须带 auth: { token }，用户身份完全由服务端解析
io.use((socket, next) => {
  const raw = socket.handshake.auth?.token;
  if (typeof raw !== 'string' || !raw) {
    next(new Error('缺少登录 token'));
    return;
  }
  const user = findUserByTokenHash(createHash('sha256').update(raw).digest('hex'));
  if (!user || user.status === 'banned') {
    next(new Error('登录已失效'));
    return;
  }
  socket.data.user = user;
  next();
});

// socket 实时聊天：进房订阅 + 消息落库后只广播给房内
io.on('connection', (socket) => {
  const user = socket.data.user;
  console.log(`connected: ${user.username}(${user.id})`);
  socket.join(userChannel(user.id)); // 未读数按用户维度推送（覆盖其所有标签页）

  // 进入房间：加入 socket.io 频道；公共房顺手记录成员，私有房必须是已有成员
  socket.on('room:enter', (roomId, ack) => {
    try {
      if (!Number.isInteger(roomId) || roomId <= 0) {
        ack({ ok: false, error: '无效的房间 id' });
        return;
      }
      const room = getRoomById(roomId);
      if (!room || (!room.isPublic && !isRoomMember(room.id, user.id))) {
        // 错误文案不暴露房间是否存在
        ack({ ok: false, error: '房间不存在或你还未加入（私有房请先输入房间 ID 和密码加入）' });
        return;
      }
      socket.join(roomChannel(room.id));
      addRoomMember(room.id, user.id); // 进入即记录成员（幂等；私有房在此为 no-op）
      markRoomRead(room.id, user.id); // 必须在 addRoomMember 之后：进房即视为已读
      // 该用户其它标签页同步清零；本标签页的 ack 也带回 0
      io.to(userChannel(user.id)).emit('unread', { roomId: room.id, unreadCount: 0 });
      ack({ ok: true, room: { ...room, isMember: true, unreadCount: 0 } });
    } catch (err) {
      console.error(err);
      ack({ ok: false, error: '服务器内部错误' });
    }
  });

  // 离开房间：只退出 socket.io 频道，成员关系保留
  socket.on('room:leave', (roomId) => {
    if (!Number.isInteger(roomId)) return;
    socket.leave(roomChannel(roomId));
  });

  socket.on('message', (payload, ack) => {
    try {
      if (typeof payload !== 'object' || payload === null) {
        ack?.({ ok: false, error: '请求体必须为 { roomId, text }' });
        return;
      }
      const { roomId, text } = payload as { roomId?: unknown; text?: unknown };
      if (!Number.isInteger(roomId) || (roomId as number) <= 0 || typeof text !== 'string') {
        ack?.({ ok: false, error: '请求体必须为 { roomId, text }' });
        return;
      }
      const body = text.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!body) {
        ack?.({ ok: false, error: '消息不能为空' });
        return;
      }
      const room = getRoomById(roomId as number);
      if (!room) {
        ack?.({ ok: false, error: '聊天室不存在' });
        return;
      }
      const channel = roomChannel(room.id);
      if (!socket.rooms.has(channel)) {
        // 重连/竞态兜底：服务端补校验并加入频道
        if (!room.isPublic && !isRoomMember(room.id, user.id)) {
          ack?.({ ok: false, error: '你不是该聊天室的成员' });
          return;
        }
        socket.join(channel);
        addRoomMember(room.id, user.id);
      }
      console.log(`message from ${user.username} in room ${room.id}`);
      const message = saveMessage(room.id, user, body); // 先落库
      io.to(channel).emit('message', message); // 只发给房内（含发送者）
      ack?.({ ok: true });
      // 后台同步未读数（内部先 mark 在看的人、再算数，房内成员算出来恒为 0），不阻塞 ack
      void notifyUnread(channel, room.id);
    } catch (err) {
      console.error(err);
      ack?.({ ok: false, error: '服务器内部错误' });
    }
  });

  socket.on('disconnect', () => {
    console.log(`disconnected: ${user.username}(${user.id})`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server is running at http://${HOST}:${PORT}`);
});
