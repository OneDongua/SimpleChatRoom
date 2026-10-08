import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { DefaultEventsMap } from 'socket.io';
import { Server } from 'socket.io';
import logger from './utils/logger.ts';
import {
  addRoomMember,
  createAnonymousUser,
  createRegisteredUser,
  createRoom,
  createSession,
  findUserById,
  findUserByTokenHash,
  findUserCredentials,
  getRoomById,
  getRoomPasswordHash,
  isRoomMember,
  listMessages,
  listRoomsForUser,
  listUnreadCounts,
  markRoomRead,
  saveMessage,
  upgradeAnonymousUser,
} from './db.ts';
import { hashPassword, verifyPassword } from './utils/password.ts';
import type { ClientToServerEvents, ServerToClientEvents, SocketData, User } from '../../shared/types.ts';

const HOST = '0.0.0.0';
const PORT = 3000;
const ORIGIN = '*';  // 开发环境使用
const MAX_USERNAME_LENGTH = 32;
const MAX_PASSWORD_LENGTH = 128;
const MIN_PASSWORD_LENGTH = 6;
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

// CORS 中间件必须放在 express.json() 之前：保证后面解析/校验失败返回的 400 也带上 CORS 头，
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

app.post('/api/auth/anonymous', (_req, res) => {
  const username = `游客_${randomBytes(3).toString('hex').toUpperCase()}`; // 6 位 16 进制字符
  const user = createAnonymousUser(username);
  console.log(`[auth] 匿名用户已创建: ${user.username}(${user.id})`);
  res.status(201).json({ user, token: issueToken(user) });
});

app.post('/api/auth/register', (req, res) => {
  const username = readUsername(req.body);
  const password = readPassword(req.body);
  if (!username || !password || !checkUsernameAndPassword(username, password)) {
    res.status(400).json({ error: `用户名长度不超过 ${MAX_USERNAME_LENGTH} 个字符，密码长度需为 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 个字符` });
    return;
  }
  if (findUserCredentials(username)) {
    console.warn(`[auth] 注册失败，用户名已存在: ${username}`);
    res.status(409).json({ error: '用户名已存在' });
    return;
  }
  const user = createRegisteredUser(username, hashPassword(password));
  console.log(`[auth] 用户注册成功: ${username}(${user.id})`);
  res.status(201).json({ user, token: issueToken(user) });
});

app.post('/api/auth/login', (req, res) => {
  const username = readUsername(req.body);
  const password = readPassword(req.body);
  const credentials = username ? findUserCredentials(username) : undefined;
  if (!credentials || !credentials.passwordHash || !password || !verifyPassword(password, credentials.passwordHash)) {
    console.warn(`[auth] 登录失败（用户名或密码错误）: ${username ?? '(空)'}`);
    res.status(401).json({ error: '用户名或密码错误' });
    return;
  }
  if (credentials.user.status === 'banned') {
    console.warn(`[auth] 拒绝登录，用户已被封禁: ${username}(${credentials.user.id})`);
    res.status(403).json({ error: '该用户已被封禁' });
    return;
  }
  console.log(`[auth] 登录成功: ${username}(${credentials.user.id})`);
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
  const password = readPassword(req.body);
  if (!username || !password || !checkUsernameAndPassword(username, password)) {
    res.status(400).json({ error: `用户名长度不超过 ${MAX_USERNAME_LENGTH} 个字符，密码长度需为 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 个字符` });
    return;
  }
  if (findUserCredentials(username)) {
    res.status(409).json({ error: '用户名已存在' });
    return;
  }
  const upgraded = upgradeAnonymousUser(user.id, username, hashPassword(password));
  if (!upgraded) {
    console.error(`[auth] 匿名用户升级失败（写入未生效）: user(${user.id}) -> ${username}`);
    res.status(409).json({ error: '匿名用户升级失败' });
    return;
  }
  console.log(`[auth] 匿名用户升级成功: ${user.username}(${user.id}) -> ${username}`);
  res.json({ user: upgraded, token: issueToken(upgraded) });
});

// 按 id 查询用户
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
// 私有房必须设置密码，公共房不允许带密码
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
    // 仅拒绝全空白，避免误触创建"看似无密码"的房
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
  console.log(`[room] 创建成功: ${room.name}(#${room.id}) 类型=${room.isPublic ? '公共' : '私有'} 创建者=${user.username}(${user.id})`);
  if (room.isPublic) io.emit('room:created', room); // 私有房不广播，只有创建者知道
  res.status(201).json({ ...room, isMember: true, unreadCount: 0 }); // 新房无消息，未读恒为 0
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
  // 私有房一律有密码（新建时必填），取不到哈希即拒绝
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
      console.warn(`[room] 加入被拒（密码错误）: ${user.username}(${user.id}) -> 房间 #${room.id}`);
      res.status(403).json({ error: '密码错误' });
      return;
    }
  }
  addRoomMember(room.id, user.id);
  console.log(`[room] 加入成功: ${user.username}(${user.id}) -> ${room.name}(#${room.id})`);
  // 前端 join 后必然紧接进房（room:enter 会清零并校正 unreadCount），这里的 0 只是过渡值
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
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof SyntaxError) {
    console.warn(`[http] 请求体解析失败（非法 JSON）: ${req.method} ${req.originalUrl}`);
    res.status(400).json({ error: '请求体不是合法 JSON' });
    return;
  }
  console.error(`[http] 未处理异常: ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: '服务器内部错误' });
});

// socket.io 连接握手校验中间件：客户端必须带 auth: { token }，用户身份完全由服务端解析
io.use((socket, next) => {
  const raw = socket.handshake.auth?.token;
  if (typeof raw !== 'string' || !raw) {
    next(new Error('缺少登录 token'));
    return;
  }
  const user = findUserByTokenHash(createHash('sha256').update(raw).digest('hex'));
  if (!user || user.status === 'banned') {
    console.warn('[socket] 握手鉴权失败（token 无效或已失效）');
    next(new Error('登录已失效'));
    return;
  }
  socket.data.user = user;
  next();
});

// socket.io 实时聊天：进房订阅 + 消息落库后广播给房内
io.on('connection', (socket) => {
  const user = socket.data.user;
  console.log(`[socket] 连接建立: ${user.username}(${user.id})`);
  socket.join(userChannel(user.id));

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
      addRoomMember(room.id, user.id); // 进入即记录成员（幂等；私有房在此自动忽略）
      markRoomRead(room.id, user.id); // 必须在 addRoomMember 之后：进房即视为已读
      // 该用户其它标签页 unreadCount 同步清零；本标签页的 ack 也带回 0
      io.to(userChannel(user.id)).emit('unread', { roomId: room.id, unreadCount: 0 });
      console.log(`[socket] 进房: ${user.username}(${user.id}) -> ${room.name}(#${room.id})`);
      ack({ ok: true, room: { ...room, isMember: true, unreadCount: 0 } });
    } catch (err) {
      console.error(`[socket] room:enter 处理异常: user(${user.id}) roomId=${roomId}`, err);
      ack({ ok: false, error: '服务器内部错误' });
    }
  });

  // 离开房间：只退出 socket.io 频道
  socket.on('room:leave', (roomId) => {
    if (!Number.isInteger(roomId)) return;
    socket.leave(roomChannel(roomId));
  });

  // 收到消息：先落库，再广播给房内成员，最后处理未读数
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
        console.log(`[socket] 发消息时未在房，服务端补入房: ${user.username}(${user.id}) -> 房间 #${room.id}`);
      }
      console.log(`[socket] 消息: ${user.username}(${user.id}) -> 房间 #${room.id}`);
      const message = saveMessage(room.id, user, body); // 先落库
      io.to(channel).emit('message', message); // 只发给房内（含发送者）
      ack?.({ ok: true });
      // 异步通知未读数（内部先 mark 在看的人、再算数，房内成员算出来恒为 0），不阻塞 ack
      notifyUnread(channel, room.id);
    } catch (err) {
      console.error('[socket] message 处理异常', err);
      ack?.({ ok: false, error: '服务器内部错误' });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[socket] 断开连接: ${user.username}(${user.id})`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server is running at http://${HOST}:${PORT}`);
});

/**
 * 把未知值（数字或数字字符串）解析为正整数；
 * 其余（0、空串、NaN、小数、负数、数组等）返回 undefined
 */
function readPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** 获取房间频道名 */
const roomChannel = (roomId: number) => `room:${roomId}`;

/** 获取用户频道名，用于同步未读数 */
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

/**
 * 为指定用户签发一个新的登录令牌：生成随机 token，只在库中存其 sha256 摘要，
 * 并建立有效期为 SESSION_DAYS 天的会话。明文 token 返回给客户端，服务端不留存。
 * @param user - 通过登录校验的用户。
 * @returns 明文令牌字符串（供客户端后续以 Bearer 方式携带）。
 */
function issueToken(user: User): string {
  const token = randomBytes(32).toString('hex');
  createSession(user.id, createHash('sha256').update(token).digest('hex'), Date.now() + SESSION_DAYS * 86400000);
  return token;
}

/**
 * 从请求的 Authorization 头中提取 Bearer 令牌。
 * @param req - Express 请求对象。
 * @returns 去掉 "Bearer " 前缀后的令牌；头缺失或格式不符时返回 undefined。
 */
function bearerToken(req: Request): string | undefined {
  const value = req.header('authorization');
  return value?.startsWith('Bearer ') ? value.slice(7).trim() : undefined;
}

/**
 * 校验请求携带的令牌并返回对应的登录用户；已被封禁（banned）的用户同样视为无效。
 * 校验失败时直接向响应写入 401，调用方只需处理返回 undefined 的分支。
 * @param req - Express 请求对象。
 * @param res - Express 响应对象（失败时用于写回 401）。
 * @returns 已鉴权的用户；未登录、令牌失效或已被封禁时返回 undefined。
 */
function authenticatedUser(req: Request, res: Response): User | undefined {
  const token = bearerToken(req);
  const user = token ? findUserByTokenHash(createHash('sha256').update(token).digest('hex')) : undefined;
  if (!user || user.status === 'banned') {
    res.status(401).json({ error: '未登录或登录已失效' });
    return undefined;
  }
  return user;
}

/**
 * 从请求体中安全读取并规范化用户名：去除首尾空白，并要求非空且不超过长度上限。
 * @param body - 未知结构的请求体。
 * @returns 合法的用户名；字段缺失、类型不符、为空或超长时返回 undefined。
 */
function readUsername(body: unknown): string | undefined {
  const raw = (body as { username?: unknown } | undefined)?.username;
  if (typeof raw !== 'string') return undefined;
  return raw.trim();
}

function readPassword(body: unknown): string | undefined {
  const raw = (body as { password?: unknown } | undefined)?.password;
  if (typeof raw !== 'string') return undefined;
  return raw;
}

function checkUsernameAndPassword(username: string, password: string): boolean {
  return username.length <= MAX_USERNAME_LENGTH &&
    password.length >= MIN_PASSWORD_LENGTH &&
    password.length <= MAX_PASSWORD_LENGTH;
}
