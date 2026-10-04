import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import type { ChatMessage, User } from './socket/socket.ts';
import { connectAs, socket } from './socket/socket.ts';
import { login } from './api.ts';
import './App.css';

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [username, setUsername] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [connError, setConnError] = useState('');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // 登录：find-or-create，成功后进入聊天室
  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    const name = username.trim();
    if (!name || loggingIn) return; // 防止回车/连点重复提交
    setLoggingIn(true);
    setLoginError('');
    try {
      const logged = await login(name);
      setMessages([]); // 换用户后清空本地消息，避免"串台"
      setConnError('');
      setUser(logged);
    } catch (err) {
      setLoginError(err instanceof Error ? `登录失败: ${err.message}` : '登录失败，请重试');
    } finally {
      setLoggingIn(false);
    }
  };

  // 发送消息函数
  const sendMessage = () => {
    if (input) {
      socket.emit('message', input.trim());
      setInput('');
    }
  };

  // 登录后建立连接；未登录不连接（避免被服务端握手校验拒绝）
  useEffect(() => {
    if (!user) return;

    // 先挂监听再 connect，避免握手后立刻到达的消息丢失
    const onMessage = (message: ChatMessage) => {
      setMessages((prev) => [...prev, message]);
    };
    const onConnect = () => setConnError('');
    const onConnectError = (err: Error) => {
      console.error('socket 连接失败：', err.message);
      setConnError(`连接失败：${err.message}`);
    };
    socket.on('message', onMessage);
    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
    connectAs(user.id);

    return () => {
      socket.off('message', onMessage);
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
      socket.disconnect();
    };
  }, [user]);

  // 收到新消息后滚动到底部
  useEffect(() => {
    if (!user || messages.length === 0) return;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  }, [user, messages]);

  // 未登录：登录界面
  if (!user) {
    return (
      <div className="login-screen">
        <form className="login-form" onSubmit={handleLogin}>
          <h2 className="login-title">聊天室</h2>
          <p className="login-tip">输入用户名进入，不存在将自动注册</p>
          <input
            className="login-input"
            value={username}
            maxLength={32}
            autoFocus
            placeholder="用户名"
            onChange={(e) => setUsername(e.target.value)}
          />
          <button className="login-btn" type="submit" disabled={!username.trim() || loggingIn}>
            {loggingIn ? '进入中…' : '进入聊天室'}
          </button>
          {loginError && <p className="login-error">{loginError}</p>}
        </form>
      </div>
    );
  }

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
          {messages.map((message, index) => (
            <div
              key={`${message.timestamp}-${index}`}
              className={message.senderId === user.id ? 'message is-own' : 'message is-other'}
            >
              <div className="message-sender">
                {message.senderId === user.id ? '我' : message.username}
              </div>
              {message.text}
            </div>
          ))}
        </div>

        <div className="chat-input-box">
          <div className="chat-user-bar">
            <div>
              <span>以 {user.username} 身份发言 ·</span>
              <button
                className="chat-user-switch"
                type="button"
                onClick={() => {
                  setMessages([]);
                  setUser(null);
                }}
              >
                切换用户
              </button>
            </div>
            {connError && <div className="conn-error">{connError}</div>}
          </div>
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
