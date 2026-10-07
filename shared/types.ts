// 前后端共用的类型定义。
// 注意：本文件只允许放类型（无运行时代码）——前端以 import type 跨目录引用，
// 打包时会被完全擦除，Vite 无需处理 src 之外的模块。

/** 用户（对应数据库 users 表的一行） */
export type UserStatus = 'anonymous' | 'registered' | 'admin' | 'banned';

export interface User {
  id: number;
  username: string;
  status: UserStatus;
}

export interface AuthResponse {
  user: User;
  token: string;
}

/** REST 接口的错误响应体 */
export interface ApiError {
  error: string;
}

/** 聊天室（对应数据库 rooms 表的一行） */
export interface Room {
  id: number;
  name: string;
  /** true 公共（出现在所有用户界面）/ false 私有（仅出现在成员界面） */
  isPublic: boolean;
  /** 创建者用户 id；0 表示系统（播种的"公共大厅"） */
  creatorId: number;
  /** 创建时间（毫秒时间戳） */
  createdAt: number;
}

/** 房间列表项：Room + 请求者是否为成员的标记 */
export interface RoomInfo extends Room {
  /** 请求者是否已加入（进入过公共房或加入过私有房） */
  isMember: boolean;
  /** 请求者在此房的未读数；非成员恒为 0 */
  unreadCount: number;
}

// 前后端共用的聊天消息结构
export interface ChatMessage {
  id: number;
  roomId: number;
  /** 服务端生成的毫秒时间戳 */
  timestamp: number;
  senderId: number;
  /** 发送方用户名，随消息冗余下发（服务端 JOIN users 得到） */
  username: string;
  text: string;
}

/** 历史消息分页返回体 */
export interface MessagePage {
  /** 按 id 升序（最旧在前），可直接 prepend 到列表头部 */
  messages: ChatMessage[];
  /** 是否还有更早的消息 */
  hasMore: boolean;
}

/** 发送消息的载荷 */
export interface SendMessagePayload {
  roomId: number;
  text: string;
}

/** 发送消息的 ack 结果 */
export interface SendMessageResult {
  ok: boolean;
  error?: string;
}

/** room:enter 的 ack 结果（成功时带回 RoomInfo，客户端据此校正侧边栏） */
export type EnterRoomResult =
  | { ok: true; room: RoomInfo }
  | { ok: false; error: string };

/** 未读数变化推送（只发给该用户的所有标签页，见 user:<id> 频道） */
export interface UnreadUpdate {
  roomId: number;
  unreadCount: number;
}

/** 服务端 -> 客户端 事件 */
export interface ServerToClientEvents {
  /** 房间内新消息（已落库，只发给 room:<id> 频道内的人） */
  message: (message: ChatMessage) => void;
  /** 新公共聊天室创建成功（广播给全体在线用户；私有房不广播） */
  'room:created': (room: Room) => void;
  /** 未读数变化：进房清零、不在看的房间来新消息累积 */
  unread: (update: UnreadUpdate) => void;
}

/** 客户端 -> 服务端 事件 */
export interface ClientToServerEvents {
  /** 发送聊天消息到指定房间；ack 可选 */
  message: (payload: SendMessagePayload, ack?: (result: SendMessageResult) => void) => void;
  /** 进入房间：加入 socket.io 频道、写入成员（公共房）；私有房必须是已有成员 */
  'room:enter': (roomId: number, ack: (result: EnterRoomResult) => void) => void;
  /** 离开房间：仅退出 socket.io 频道，成员关系保留 */
  'room:leave': (roomId: number) => void;
}

/** 挂在 socket.data 上的数据，由 io.use 中间件写入 */
export interface SocketData {
  user: User;
}
