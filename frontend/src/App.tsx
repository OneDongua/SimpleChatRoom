import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import type { User } from './socket/socket.ts';
import { anonymous, currentUser, login, register } from './api.ts';
import { useChatSocket } from './hooks/useChatSocket.ts';
import { useFormError } from './hooks/useFormError.ts';
import Sidebar from './components/Sidebar.tsx';
import MessageList from './components/MessageList.tsx';
import ChatInput from './components/ChatInput.tsx';
import './App.css';

type AuthTab = 'anonymous' | 'login' | 'register';

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('chat_token'));
  const [authTab, setAuthTab] = useState<AuthTab>('anonymous');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useFormError();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const chat = useChatSocket(user, token);

  useEffect(() => {
    if (!token || user) return;
    currentUser().then(({ user: restored }) => setUser(restored)).catch(() => {
      localStorage.removeItem('chat_token');
      setToken(null);
    });
  }, [token, user]);

  const enter = (result: { user: User; token: string }) => {
    localStorage.setItem('chat_token', result.token);
    setToken(result.token);
    setUser(result.user);
  };
  const handleAnonymous = async () => {
    if (loggingIn) return;
    setLoggingIn(true);
    setLoginError('');
    try {
      enter(await anonymous());
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : '进入失败，请重试');
    } finally {
      setLoggingIn(false);
    }
  };
  const handleAuth = async (e: FormEvent) => {
    e.preventDefault();
    const name = username.trim();
    if (!name || !password || loggingIn) return;
    setLoggingIn(true);
    setLoginError('');
    try {
      enter(authTab === 'register' ? await register(name, password) : await login(name, password));
    } catch (err) {
      setLoginError(err instanceof Error ? `${authTab === 'register' ? '注册' : '登录'}失败: ${err.message}` : '操作失败，请重试');
    } finally {
      setLoggingIn(false);
    }
  };
  const switchUser = () => {
    chat.reset();
    setSidebarOpen(false);
    setUser(null);
    setToken(null);
    localStorage.removeItem('chat_token');
  };
  const handleSelectRoom = (roomId: number) => {
    chat.selectRoom(roomId);
    setSidebarOpen(false);
  };
  const handleCreateRoom = async (name: string, isPublic: boolean, password?: string) => {
    await chat.createRoomAndEnter(name, isPublic, password);
    setSidebarOpen(false);
  };
  const handleJoinRoom = async (roomId: number, password?: string) => {
    await chat.joinRoomById(roomId, password);
    setSidebarOpen(false);
  };

  if (!user) return (
    <div className="login-screen">
      <div className="login-form">
        <h2 className="login-title">聊天室</h2>
        <div className="auth-tabs">
          <span
            className={`auth-tabs-slider${authTab === 'anonymous' ? '' : ' is-right'}`}
            aria-hidden="true"/>
          <button
            type="button"
            className={authTab === 'anonymous' ? 'is-active' : ''}
            onClick={() => setAuthTab('anonymous')}>匿名
          </button>
          <button
            type="button"
            className={authTab !== 'anonymous' ? 'is-active' : ''}
            onClick={() => setAuthTab('login')}>
            {authTab === 'register' ? '注册' : '登录'}
          </button>
        </div>
        {authTab === 'anonymous' ? (
          <>
            <p className="login-tip">无需注册即可进入公共聊天室</p>
            <button
              className="login-btn"
              type="button"
              onClick={handleAnonymous}
              disabled={loggingIn}>{loggingIn ? '进入中…' : '匿名进入'}</button>
          </>
        ) : (
          <form onSubmit={handleAuth}>
            <input
              className="login-input"
              value={username}
              maxLength={32}
              autoFocus
              placeholder="用户名"
              onChange={(e) => setUsername(e.target.value)}/>
            <input
              className="login-input"
              type="password"
              value={password}
              maxLength={128}
              placeholder="密码"
              onChange={(e) => setPassword(e.target.value)}/>
            <button
              className="login-btn"
              type="submit"
              disabled={!username.trim() || !password || loggingIn}>
              {loggingIn ? '处理中…' : authTab === 'register' ? '注册并进入' : '登录'}
            </button>
            <button
              className="login-register-link"
              type="button"
              onClick={() => setAuthTab(authTab === 'register' ? 'login' : 'register')}>
              {authTab === 'register' ? '已有账号？返回登录' : '还没有账号？去注册'}
            </button>
          </form>
        )}
        {loginError && <p className="login-error">{loginError}</p>}
      </div>
    </div>
  );

  return (
    <>
      <Sidebar
        open={sidebarOpen}
        rooms={chat.rooms}
        currentRoomId={chat.currentRoomId}
        onSelectRoom={handleSelectRoom}
        onCreateRoom={handleCreateRoom}
        onJoinRoom={handleJoinRoom}
        canCreatePublic={user.status !== 'anonymous'}/>

      <div
        className={`sidebar-backdrop${sidebarOpen ? ' is-open' : ''}`}
        aria-hidden="true"
        onClick={() => setSidebarOpen(false)}/>

      <div className="chat-room">

        {/* 未进房时没有标题，桌面端整条隐藏，移动端保留菜单按钮入口 */}
        <div className={`chat-header${chat.currentRoom ? '' : ' is-empty'}`}>
          <button
            className="mobile-menu-btn"
            type="button"
            aria-label="打开聊天室列表"
            onClick={() => setSidebarOpen(true)}>
            <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px"
                 fill="var(--text)">
              <path
                d="M160-240q-17 0-28.5-11.5T120-280q0-17 11.5-28.5T160-320h640q17 0 28.5 11.5T840-280q0 17-11.5 28.5T800-240H160Zm0-200q-17 0-28.5-11.5T120-480q0-17 11.5-28.5T160-520h640q17 0 28.5 11.5T840-480q0 17-11.5 28.5T800-440H160Zm0-200q-17 0-28.5-11.5T120-680q0-17 11.5-28.5T160-720h640q17 0 28.5 11.5T840-680q0 17-11.5 28.5T800-640H160Z"/>
            </svg>
          </button>
          {chat.currentRoom && <span className="chat-header-title">{chat.currentRoom.name}</span>}
        </div>

        {chat.currentRoomId === null ?
          (
            <div className="empty-state">选择或创建一个聊天室开始聊天</div>
          ) : (
            <MessageList
              key={chat.currentRoomId}
              myId={user.id}
              messages={chat.messages}
              hasMore={chat.hasMore}
              loadingOlder={chat.loadingOlder}
              onLoadOlder={chat.loadOlder}/>
          )}

        <ChatInput
          username={user.username}
          disabled={chat.currentRoomId === null}
          connError={chat.connError}
          roomError={chat.roomError}
          onSend={chat.sendMessage}
          onSwitchUser={switchUser}/>

        <div className="chat-input-bg-mask"/>
      </div>

    </>
  );
}

export default App;
