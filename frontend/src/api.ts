import type { ApiError, MessagePage, RoomInfo, User } from '../../shared/types.ts';
import { SERVER_URL } from './socket/socket.ts';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** 统一请求封装：非 2xx 时优先读 { error } 文案，解析失败再兜底 HTTP 状态 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, init);
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(data?.error ?? `请求失败（HTTP ${res.status}）`);
  }
  return (await res.json()) as T;
}

/** find-or-create 登录：用户名不存在时后端自动注册（201），已存在直接返回（200） */
export function login(username: string): Promise<User> {
  return request<User>('/api/users', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ username }),
  });
}

/** 当前用户可见的聊天室：公共房全部 + 私有房中已加入的 */
export function listRooms(userId: number): Promise<RoomInfo[]> {
  return request<RoomInfo[]>(`/api/rooms?userId=${userId}`);
}

/** 创建聊天室；创建者自动成为成员。私有房必须设置密码，公共房不能传 password */
export function createRoom(input: {
  name: string;
  isPublic: boolean;
  password?: string;
  userId: number;
}): Promise<RoomInfo> {
  return request<RoomInfo>('/api/rooms', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}

/** 加入聊天室（幂等）：私有房需提供正确密码；空密码视同未提供，已是成员时不校验 */
export function joinRoom(roomId: number, userId: number, password?: string): Promise<RoomInfo> {
  return request<RoomInfo>(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ userId, ...(password ? { password } : {}) }),
  });
}

/** 历史消息（游标分页；升序返回，可直接 prepend） */
export function fetchMessages(
  roomId: number,
  userId: number,
  opts?: { before?: number; limit?: number },
): Promise<MessagePage> {
  const params = new URLSearchParams({ userId: String(userId) });
  if (opts?.before !== undefined) params.set('before', String(opts.before));
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  return request<MessagePage>(`/api/rooms/${roomId}/messages?${params.toString()}`);
}
