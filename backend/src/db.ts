import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { User } from '../../shared/types.ts';

// 数据库固定放在 backend/data/chat.db：用 import.meta.dirname 解析绝对路径，
// 不依赖启动时的 CWD（从任何目录启动 node/tsx 都指向同一个库）
const DATA_DIR = join(import.meta.dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'chat.db');

// SQLite 不会自动创建父目录，缺目录会报 unable to open database file
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// 创建表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE
  );
`);

// 数据库操作预编译语句（表创建之后才能 prepare）
const selectById = db.prepare('SELECT id, username FROM users WHERE id = ?');
const selectByName = db.prepare('SELECT id, username FROM users WHERE username = ?');
// 并发下两个请求同时插同名用户时，ON CONFLICT DO NOTHING 让后到的那条静默失败（不抛异常），
// 配合下面的回退 SELECT 实现无竞态的 find-or-create
const insertUser = db.prepare(
  'INSERT INTO users (username) VALUES (?) ON CONFLICT(username) DO NOTHING RETURNING id, username'
);

/**
 * 将 node:sqlite 返回的 null-prototype 记录转成普通 User 对象。
 * @param row - 从数据库查询得到的未知类型记录，可能为 null 或非对象值。
 * @returns 若 row 包含合法的 id(number) 和 username(string)，返回对应的 {@link User} 对象；否则返回 undefined。
 */
function toUser(row: unknown): User | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const { id, username } = row as Record<string, unknown>;
  if (typeof id !== 'number' || typeof username !== 'string') return undefined;
  return { id, username };
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
 * 查找或创建的用户名：不存在则注册，存在则直接返回
 * @param username - 待查找或创建的用户名。
 * @returns 包含 user（查找或新建得到的 User 对象）与 created（true 表示本次新建，false 表示已存在）的对象。
 */
export function findOrCreateUser(username: string): { user: User; created: boolean } {
  const existing = findUserByUsername(username);
  if (existing) return { user: existing, created: false };

  const inserted = toUser(insertUser.get(username));
  if (inserted) return { user: inserted, created: true };

  // SELECT 与 INSERT 之间被并发请求抢先插入，回退再查一次
  const raced = findUserByUsername(username);
  if (raced) return { user: raced, created: false };

  throw new Error(`findOrCreateUser 失败: ${username}`); // 理论上不可达
}
