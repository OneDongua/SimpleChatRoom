import type { ApiError, AuthResponse, MessagePage, RoomInfo, User } from '../../shared/types.ts';
import { SERVER_URL } from './socket/socket.ts';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** 统一请求封装：非 2xx 时优先读 { error } 文案，解析失败再兜底 HTTP 状态 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type') && init?.body) headers.set('Content-Type', 'application/json');
  const token = localStorage.getItem('chat_token');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`${SERVER_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(data?.error ?? `请求失败（HTTP ${res.status}）`);
  }
  return (await res.json()) as T;
}

export function anonymous(): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/anonymous', { method: 'POST' });
}

export function login(username: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/login', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ username, password }),
  });
}

export function register(username: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/register', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ username, password }),
  });
}

export function upgrade(username: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>('/api/auth/upgrade', {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ username, password }),
  });
}

export function currentUser(): Promise<{ user: User }> {
  return request<{ user: User }>('/api/auth/me');
}

/** 当前用户可见的聊天室：公共房全部 + 私有房中已加入的 */
export function listRooms(): Promise<RoomInfo[]> {
  return request<RoomInfo[]>('/api/rooms');
}

/** 创建聊天室；创建者自动成为成员。私有房必须设置密码，公共房不能传 password */
export function createRoom(input: {
  name: string;
  isPublic: boolean;
  password?: string;
}): Promise<RoomInfo> {
  return request<RoomInfo>('/api/rooms', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}

/** 加入聊天室（幂等）：私有房需提供正确密码；空密码视同未提供，已是成员时不校验 */
export function joinRoom(roomId: number, password?: string): Promise<RoomInfo> {
  return request<RoomInfo>(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(password ? { password } : {}),
  });
}

/** 历史消息（游标分页；升序返回，可直接 prepend） */
export function fetchMessages(
  roomId: number,
  opts?: { before?: number; limit?: number },
): Promise<MessagePage> {
  const params = new URLSearchParams();
  if (opts?.before !== undefined) params.set('before', String(opts.before));
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  return request<MessagePage>(`/api/rooms/${roomId}/messages?${params.toString()}`);
}
