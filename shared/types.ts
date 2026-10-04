// 前后端共用的类型定义。
// 注意：本文件只允许放类型（无运行时代码）——前端以 import type 跨目录引用，
// 打包时会被完全擦除，Vite 无需处理 src 之外的模块。

/** 用户（对应数据库 users 表的一行） */
export interface User {
  id: number;
  username: string;
}

/** REST 接口的错误响应体 */
export interface ApiError {
  error: string;
}

// 前后端共用的聊天消息结构
export interface ChatMessage {
  /** 服务端生成的毫秒时间戳，前端用作列表渲染 key 的一部分 */
  timestamp: number;
  /** 发送方的用户 id（不再是 socket.id），前端用于区分消息归属 */
  senderId: number;
  /** 发送方用户名，随消息冗余下发，前端直接展示、无需再查用户表 */
  username: string;
  /** 消息文本 */
  text: string;
}

/** 服务端 -> 客户端 事件 */
export interface ServerToClientEvents {
  message: (message: ChatMessage) => void;
}

/** 客户端 -> 服务端 事件 */
export interface ClientToServerEvents {
  /** 发送聊天消息（纯文本） */
  message: (text: string) => void;
}

/** 挂在 socket.data 上的数据，由 io.use 中间件写入 */
export interface SocketData {
  user: User;
}
