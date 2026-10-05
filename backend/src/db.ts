import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, MessagePage, Room, RoomInfo, User } from '../../shared/types.ts';
import { hashPassword } from './utils/password.ts';

// 数据库固定放在 backend/data/chat.db：用 import.meta.dirname 解析绝对路径，
// 不依赖启动时的 CWD（从任何目录启动 node/tsx 都指向同一个库）
const DATA_DIR = join(import.meta.dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'chat.db');

// SQLite 不会自动创建父目录，缺目录会报 unable to open database file
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// 创建表
db.exec(`
    CREATE TABLE IF NOT EXISTS users
    (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT    NOT NULL UNIQUE,
        status        TEXT    NOT NULL DEFAULT 'registered',
        password_hash TEXT,
        created_at    INTEGER NOT NULL DEFAULT 0,
        updated_at    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions
    (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        token_hash TEXT    NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms
    (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT    NOT NULL,
        is_public     INTEGER NOT NULL, -- 1 公共 / 0 私有
        creator_id    INTEGER NOT NULL, -- 0 = 系统（播种房）
        created_at    INTEGER NOT NULL, -- 毫秒
        password_hash TEXT              -- scrypt 哈希；NULL = 无密码（公共房）
    );

    CREATE TABLE IF NOT EXISTS room_members
    (
        room_id   INTEGER NOT NULL,
        user_id   INTEGER NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages
    (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id   INTEGER NOT NULL,
        sender_id INTEGER NOT NULL,
        text      TEXT    NOT NULL,
        timestamp INTEGER NOT NULL
    );

    -- 历史消息查询热点：WHERE room_id = ? [AND id < ?] ORDER BY id DESC
    -- room_id 前置等值过滤，id 紧随其后使反向扫描即可取最新页，免去排序
    CREATE INDEX IF NOT EXISTS idx_messages_room_id_id ON messages (room_id, id);
`);

// 兼容已有数据库：CREATE TABLE IF NOT EXISTS 不会补列。
const userColumns = db.prepare("SELECT name FROM pragma_table_info('users')").all();
const userColumnNames = userColumns.map((row) => row.name);
if (!userColumnNames.includes('status')) db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'registered'");
if (!userColumnNames.includes('password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
if (!userColumnNames.includes('created_at')) db.exec('ALTER TABLE users ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
if (!userColumnNames.includes('updated_at')) db.exec('ALTER TABLE users ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
const migrationNow = Date.now();
db.prepare('UPDATE users SET created_at = CASE WHEN created_at = 0 THEN ? ELSE created_at END, updated_at = CASE WHEN updated_at = 0 THEN ? ELSE updated_at END').run(migrationNow, migrationNow);

// 旧库的 rooms 表创建时还没有 password_hash 列（CREATE TABLE IF NOT EXISTS 不会补列），
// 用 pragma 探测后 ALTER 补齐。必须在下面所有 prepare 之前完成，否则旧库 prepare 会因缺列抛错。
const roomColumns = db.prepare("SELECT name FROM pragma_table_info('rooms')").all();
if (!roomColumns.some((row) => row.name === 'password_hash')) {
  db.exec('ALTER TABLE rooms ADD COLUMN password_hash TEXT');
  // 仅测试数据：旧的私有房没有密码，统一回填为 0000（哈希存储），使私有房一律有密码
  db.prepare('UPDATE rooms SET password_hash = ? WHERE is_public = 0 AND password_hash IS NULL')
    .run(hashPassword('0000'));
}

// 数据库操作预编译语句（表创建之后才能 prepare）
const selectById = db.prepare('SELECT id, username, status FROM users WHERE id = ?');
const selectByName = db.prepare('SELECT id, username, status, password_hash FROM users WHERE username = ?');
// 并发下两个请求同时插同名用户时，ON CONFLICT DO NOTHING 让后到的那条静默失败（不抛异常），
// 配合下面的回退 SELECT 实现无竞态的 find-or-create
const insertUser = db.prepare(
  "INSERT INTO users (username, status, created_at, updated_at) VALUES (?, 'anonymous', ?, ?) RETURNING id, username, status"
);
const insertRegisteredUser = db.prepare(
  "INSERT INTO users (username, status, password_hash, created_at, updated_at) VALUES (?, 'registered', ?, ?, ?) RETURNING id, username, status"
);
const updateUserToRegistered = db.prepare(
  "UPDATE users SET username = ?, status = 'registered', password_hash = ?, updated_at = ? WHERE id = ? AND status = 'anonymous' RETURNING id, username, status"
);
const insertSession = db.prepare('INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)');
const selectSessionUser = db.prepare('SELECT u.id, u.username, u.status FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?');

const countRooms = db.prepare('SELECT COUNT(*) AS c FROM rooms');
const insertRoom = db.prepare(
  'INSERT INTO rooms (name, is_public, creator_id, created_at, password_hash) VALUES (?, ?, ?, ?, ?)' +
  ' RETURNING id, name, is_public, creator_id, created_at'
);
const selectRoomById = db.prepare(
  'SELECT id, name, is_public, creator_id, created_at FROM rooms WHERE id = ?'
);
// 密码哈希只在服务端流转（校验用），绝不放进 Room/RoomInfo，避免随 API 响应或广播外泄
const selectRoomPasswordHash = db.prepare('SELECT password_hash FROM rooms WHERE id = ?');
// 公共房全部返回；私有房仅当该用户是成员（LEFT JOIN 只绑一个 ?）
const selectRoomsForUser = db.prepare(`
    SELECT r.id,
           r.name,
           r.is_public,
           r.creator_id,
           r.created_at,
           (m.user_id IS NOT NULL) AS is_member
    FROM rooms r
             LEFT JOIN room_members m ON m.room_id = r.id AND m.user_id = ?
    WHERE r.is_public = 1
       OR m.user_id IS NOT NULL
    ORDER BY r.is_public DESC, r.id ASC
`);
// 重复加入时被忽略、无行返回（.get() 为 undefined），据此判断是否真的新增了成员
const insertMember = db.prepare(
  'INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?) RETURNING room_id'
);
const selectMember = db.prepare('SELECT 1 AS ok FROM room_members WHERE room_id = ? AND user_id = ?');
const insertMessage = db.prepare(
  'INSERT INTO messages (room_id, sender_id, text, timestamp) VALUES (?, ?, ?, ?) RETURNING id'
);
const selectLatestMessages = db.prepare(`
    SELECT m.id, m.room_id, m.sender_id, m.text, m.timestamp, u.username
    FROM messages m
             JOIN users u ON u.id = m.sender_id
    WHERE m.room_id = ?
    ORDER BY m.id DESC
    LIMIT ?
`);
const selectMessagesBefore = db.prepare(`
    SELECT m.id, m.room_id, m.sender_id, m.text, m.timestamp, u.username
    FROM messages m
             JOIN users u ON u.id = m.sender_id
    WHERE m.room_id = ?
      AND m.id < ?
    ORDER BY m.id DESC
    LIMIT ?
`);

/**
 * 将 node:sqlite 返回的 null-prototype 记录转成普通 User 对象。
 * @param row - 从数据库查询得到的未知类型记录，可能为 null 或非对象值。
 * @returns 若 row 包含合法的 id(number) 和 username(string)，返回对应的 {@link User} 对象；否则返回 undefined。
 */
function toUser(row: unknown): User | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const { id, username, status } = row as Record<string, unknown>;
  if (typeof id !== 'number' || typeof username !== 'string' || !['anonymous', 'registered', 'admin', 'banned'].includes(String(status))) return undefined;
  return { id, username, status: status as User['status'] };
}

/**
 * 将 rooms 表的记录转成普通 Room 对象（snake_case -> camelCase，is_public 转 boolean）。
 * @param row - 从数据库查询得到的未知类型记录。
 * @returns 字段齐全时返回 {@link Room}，否则返回 undefined。
 */
function toRoom(row: unknown): Room | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const { id, name, is_public, creator_id, created_at } = row as Record<string, unknown>;
  if (
    typeof id !== 'number' ||
    typeof name !== 'string' ||
    typeof is_public !== 'number' ||
    typeof creator_id !== 'number' ||
    typeof created_at !== 'number'
  ) {
    return undefined;
  }
  return { id, name, isPublic: is_public === 1, creatorId: creator_id, createdAt: created_at };
}

/**
 * 将带 is_member 标记的 rooms 联查记录转成 {@link RoomInfo}。
 * @param row - selectRoomsForUser 返回的未知类型记录。
 * @returns 字段齐全时返回 RoomInfo，否则返回 undefined。
 */
function toRoomInfo(row: unknown): RoomInfo | undefined {
  const room = toRoom(row);
  if (!room) return undefined;
  const { is_member } = row as Record<string, unknown>;
  if (typeof is_member !== 'number') return undefined;
  return { ...room, isMember: is_member === 1 };
}

/**
 * 将 messages 联查 users 的记录转成 {@link ChatMessage}。
 * @param row - 从数据库查询得到的未知类型记录。
 * @returns 字段齐全时返回 ChatMessage，否则返回 undefined。
 */
function toMessage(row: unknown): ChatMessage | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const { id, room_id, sender_id, text, timestamp, username } = row as Record<string, unknown>;
  if (
    typeof id !== 'number' ||
    typeof room_id !== 'number' ||
    typeof sender_id !== 'number' ||
    typeof text !== 'string' ||
    typeof timestamp !== 'number' ||
    typeof username !== 'string'
  ) {
    return undefined;
  }
  return { id, roomId: room_id, senderId: sender_id, username, text, timestamp };
}

/**
 * 按主键 id 查询用户。
 * @param id - 用户的主键 id。
 * @returns 命中则返回对应的 {@link User} 对象，未找到则返回 undefined。
 */
export function findUserById(id: number): User | undefined {
  return toUser(selectById.get(id));
}

/**
 * 按用户名 username 查询用户。
 * @param username - 用户的唯一用户名。
 * @returns 命中则返回对应的 {@link User} 对象，未找到则返回 undefined。
 */
export function findUserByUsername(username: string): User | undefined {
  return toUser(selectByName.get(username));
}

/**
 * 按用户名查询用户及其密码哈希（供登录校验使用）。
 * @param username - 用户的唯一用户名。
 * @returns 命中则返回包含 user 和 passwordHash 的对象，未找到则返回 undefined。
 */
export function findUserCredentials(username: string): { user: User; passwordHash: string | null } | undefined {
  const row = selectByName.get(username);
  const user = toUser(row);
  if (!user) return undefined;
  const passwordHash = (row as Record<string, unknown>).password_hash;
  return { user, passwordHash: typeof passwordHash === 'string' ? passwordHash : null };
}

/**
 * 创建一个匿名用户并返回。
 * @param username - 匿名用户的显示名称。
 * @returns 新创建的 {@link User} 对象。
 * @throws 若数据库插入失败则抛出错误。
 */
export function createAnonymousUser(username: string): User {
  const now = Date.now();
  const row = toUser(insertUser.get(username, now, now));
  if (!row) throw new Error('创建匿名用户失败');
  return row;
}

/**
 * 创建一个注册用户（带密码哈希）并返回。
 * @param username - 用户的唯一用户名。
 * @param passwordHash - 经过 scrypt 哈希的密码。
 * @returns 新创建的 {@link User} 对象。
 * @throws 若数据库插入失败则抛出错误。
 */
export function createRegisteredUser(username: string, passwordHash: string): User {
  const now = Date.now();
  const row = toUser(insertRegisteredUser.get(username, passwordHash, now, now));
  if (!row) throw new Error('创建注册用户失败');
  return row;
}

/**
 * 将匿名用户升级为注册用户（更改用户名并设置密码哈希）。
 * @param id - 匿名用户的主键 id。
 * @param username - 升级后的新用户名。
 * @param passwordHash - 经过 scrypt 哈希的密码。
 * @returns 升级成功则返回更新后的 {@link User}，用户不存在或状态不是 anonymous 则返回 undefined。
 */
export function upgradeAnonymousUser(id: number, username: string, passwordHash: string): User | undefined {
  return toUser(updateUserToRegistered.get(username, passwordHash, Date.now(), id));
}

/**
 * 为用户会话写入一条 session 记录。
 * @param userId - 会话所属用户的 id。
 * @param tokenHash - 会话 token 的哈希值。
 * @param expiresAt - 会话过期的毫秒时间戳。
 */
export function createSession(userId: number, tokenHash: string, expiresAt: number): void {
  insertSession.run(userId, tokenHash, Date.now(), expiresAt);
}

/**
 * 根据 token 哈希查找对应的有效会话用户。
 * @param tokenHash - 会话 token 的哈希值。
 * @returns 会话未过期则返回对应的 {@link User}，否则返回 undefined。
 */
export function findUserByTokenHash(tokenHash: string): User | undefined {
  return toUser(selectSessionUser.get(tokenHash, Date.now()));
}

/**
 * 按主键 id 查询聊天室。
 * @param id - 聊天室的主键 id。
 * @returns 命中则返回 {@link Room}，未找到则返回 undefined。
 */
export function getRoomById(id: number): Room | undefined {
  return toRoom(selectRoomById.get(id));
}

/**
 * 查询房间密码哈希（仅供服务端校验使用，绝不进入 Room/RoomInfo 或 API 响应）。
 * @param roomId - 房间 id。
 * @returns 哈希字符串；房间无密码（公共房）或不存在时返回 null。
 */
export function getRoomPasswordHash(roomId: number): string | null {
  const value = selectRoomPasswordHash.get(roomId)?.password_hash;
  return typeof value === 'string' ? value : null;
}

/**
 * 查询某用户可见的聊天室列表：公共房全部 + 私有房中该用户已加入的。
 * @param userId - 查询者的用户 id。
 * @returns 按（公共在前、id 升序）排序的 {@link RoomInfo} 数组。
 */
export function listRoomsForUser(userId: number): RoomInfo[] {
  return selectRoomsForUser
    .all(userId)
    .map(toRoomInfo)
    .filter((room): room is RoomInfo => room !== undefined);
}

/**
 * 判断用户是否为聊天室成员。
 * @returns 是成员返回 true，否则 false。
 */
export function isRoomMember(roomId: number, userId: number): boolean {
  return selectMember.get(roomId, userId) !== undefined;
}

/**
 * 创建聊天室；创建者自动成为成员（系统房 creatorId=0 除外）。两步写入包在事务里。
 * @param name - 聊天室名称。
 * @param isPublic - 是否为公共房。
 * @param creatorId - 创建者用户 id；0 表示系统播种房。
 * @param passwordHash - 私有房的密码哈希；公共房传 null（默认）。
 * @returns 新建的 {@link Room}。
 */
export function createRoom(
  name: string,
  isPublic: boolean,
  creatorId: number,
  passwordHash: string | null = null,
): Room {
  const now = Date.now();
  db.exec('BEGIN');
  try {
    const room = toRoom(insertRoom.get(name, isPublic ? 1 : 0, creatorId, now, passwordHash));
    if (!room) throw new Error('创建聊天室失败');
    if (creatorId > 0) insertMember.run(room.id, creatorId, now);
    db.exec('COMMIT');
    return room;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * 写入成员关系（幂等，重复加入不报错也不重复写）。
 * @param roomId - 目标聊天室 id。
 * @param userId - 要加入的用户 id。
 * @returns true 表示本次真的新增了成员；false 表示之前已经是成员。
 */
export function addRoomMember(roomId: number, userId: number): boolean {
  return insertMember.get(roomId, userId, Date.now()) !== undefined;
}

/**
 * 把消息落库；username 使用调用方已鉴权的 User，不再查库。
 * @param roomId - 消息所在的房间 id。
 * @param sender - 已鉴权的发送者 {@link User}。
 * @param text - 消息正文。
 * @returns 带库内 id 的完整 {@link ChatMessage}，可直接广播。
 */
export function saveMessage(roomId: number, sender: User, text: string): ChatMessage {
  const timestamp = Date.now();
  const row = insertMessage.get(roomId, sender.id, text, timestamp);
  const id = typeof row?.id === 'number' ? row.id : undefined;
  if (id === undefined) throw new Error('消息写入失败');
  return { id, roomId, senderId: sender.id, username: sender.username, text, timestamp };
}

/**
 * 按游标分页拉取历史消息（升序返回，可直接 prepend）。
 * @param roomId - 房间 id。
 * @param beforeId - 游标：只取 id 小于它的消息；null 表示取最新一页。
 * @param limit - 单页条数上限（内部多取一条用于判断 hasMore）。
 */
export function listMessages(roomId: number, beforeId: number | null, limit: number): MessagePage {
  const rows =
    beforeId === null
      ? selectLatestMessages.all(roomId, limit + 1)
      : selectMessagesBefore.all(roomId, beforeId, limit + 1);
  const hasMore = rows.length > limit;
  const messages = (hasMore ? rows.slice(0, limit) : rows)
    .map(toMessage)
    .filter((message): message is ChatMessage => message !== undefined)
    .reverse();
  return { messages, hasMore };
}

/**
 * 启动时若一个聊天室都没有，播种"公共大厅"（creator_id = 0 表示系统创建）。
 */
export function ensureDefaultRoom(): void {
  const row = countRooms.get();
  const count = typeof row?.c === 'number' ? row.c : 0;
  if (count === 0) createRoom('公共大厅', true, 0);
}

ensureDefaultRoom();
