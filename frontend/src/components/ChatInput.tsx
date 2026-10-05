import { useState } from 'react';

interface Props {
  username: string;
  /** 未选择房间时禁用输入 */
  disabled: boolean;
  connError: string;
  roomError: string;
  onSend: (text: string) => void;
  onSwitchUser: () => void;
}

/** 底部输入区：身份条 + 错误提示 + 输入框 + 发送按钮（Ctrl+Enter 发送） */
export default function ChatInput({ username, disabled, connError, roomError, onSend, onSwitchUser }: Props) {
  const [input, setInput] = useState('');

  const send = () => {
    const body = input.trim();
    if (!body || disabled) return;
    onSend(body);
    setInput('');
  };

  return (
    <div className="chat-input-box">
      <div className="chat-user-bar">
        <div>
          <span>以 {username} 身份发言 ·</span>
          <button className="chat-user-switch" type="button" onClick={onSwitchUser}>
            切换用户
          </button>
        </div>
        {(connError || roomError) && <div className="conn-error">{connError || roomError}</div>}
      </div>
      <textarea
        value={input}
        placeholder={disabled ? '请先选择一个聊天室' : '输入消息'}
        disabled={disabled}
        onChange={(e) =>
          setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key === 'Enter') {
            e.preventDefault();
            send();
          }
        }}/>
      <button
        className="chat-send-btn"
        disabled={disabled || !input.trim()}
        onClick={send}>
        发送
      </button>
    </div>
  );
}
