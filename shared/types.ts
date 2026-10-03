// 前后端共用的聊天消息结构
export interface ChatMessage {
  /** 服务端生成的毫秒时间戳，前端用作列表渲染 key */
  timestamp: number;
  /** 发送方的 id，前端用于区分消息归属 */
  senderId: string;
  /** 消息文本 */
  text: string;
}
