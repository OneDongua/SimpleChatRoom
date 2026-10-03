import { useEffect, useState } from 'react';
import { type ChatMessage, socket } from './socket/socket.ts';
import './App.css';

function App() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // 发送消息函数
  const sendMessage = () => {
    if (input) {
      socket.emit('message', input.trim());
      setInput('');
    }
  };

  // 单次 Hook
  useEffect(() => {
    socket.connect();

    // 接收到消息后更新数据
    const onMessage = (message: ChatMessage) => {
      setMessages((prev) => [...prev, message]);
    };
    socket.on('message', onMessage);

    return () => {
      socket.off('message', onMessage);
      socket.disconnect();
    };
  }, []);

  // 收到新消息后滚动到底部
  useEffect(() => {
    if (messages.length === 0) return;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  return (
    <>
      <aside className="sidebar">

        <a className="brand" href="#">
          <svg className="brand-icon" xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960"
               width="24px" fill="var(--text-primary)">
            <path
              d="M80-80v-720q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240L80-80Zm160-320h320v-80H240v80Zm0-120h480v-80H240v80Zm0-120h480v-80H240v80Z"/>
          </svg>
          <h3>
            聊天室
          </h3>
        </a>

        <div className="list-item-container">
          <a className="list-item">Chat 1</a>
        </div>

      </aside>

      <div className="chat-room">

        <div className="message-list">
          {messages.map((message) => (
            <div
              key={message.timestamp} // TODO 去重处理
              className={message.senderId === socket.id ? 'message is-own' : 'message is-other'}
            >
              {message.text}
            </div>
          ))}
        </div>

        <div className="chat-input-box">
          <textarea
            value={input}
            onChange={(e) =>
              setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 'Enter') {
              e.preventDefault();
              sendMessage();
            }
          }}/>
          <button
            className="chat-send-btn"
            disabled={!input}
            onClick={sendMessage}>
            发送
          </button>
        </div>

      </div>
    </>
  );
}

export default App
