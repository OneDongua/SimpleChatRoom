import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../../shared/types.ts';

export type { ChatMessage, MessagePage, Room, RoomInfo, User } from '../../../shared/types.ts';

/** 后端地址：api.ts 复用同一常量，避免两处硬编码 */
export const SERVER_URL = `http://${window.location.hostname}:3000`;

export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SERVER_URL, {
  autoConnect: false, // 登录拿到 userId 后再手动连接
});

/** 登录成功后调用：通过 handshake.auth 把用户 id 带给服务端 */
export function connectAs(userId: number) {
  socket.auth = { userId };
  socket.connect();
}
