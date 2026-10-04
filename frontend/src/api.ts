import type { ApiError, User } from '../../shared/types.ts';
import { SERVER_URL } from './socket/socket.ts';

/** find-or-create 登录：用户名不存在时后端自动注册（201），已存在直接返回（200） */
export async function login(username: string): Promise<User> {
  const res = await fetch(`${SERVER_URL}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });

  if (!res.ok) {
    // 错误响应通常是 400/404 的 JSON，但也兜底非 JSON 的情况，避免抛解析错
    const data = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(data?.error ?? `登录失败（HTTP ${res.status}）`);
  }
  return (await res.json()) as User;
}
