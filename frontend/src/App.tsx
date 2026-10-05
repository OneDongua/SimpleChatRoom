import type { FormEvent } from 'react';
import { useState } from 'react';
import type { User } from './socket/socket.ts';
import { login } from './api.ts';
import { useChatSocket } from './hooks/useChatSocket.ts';
import { useFormError } from './hooks/useFormError.ts';
import Sidebar from './components/Sidebar.tsx';
import MessageList from './components/MessageList.tsx';
import ChatInput from './components/ChatInput.tsx';
import './App.css';

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [username, setUsername] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useFormError(); // 5 秒后自动消失
  const [sidebarOpen, setSidebarOpen] = useState(false); // 移动端抽屉：是否展开聊天室列表

  const chat = useChatSocket(user);

  // 登录：find-or-create，成功后进入聊天室
  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    const name = username.trim();
    if (!name || loggingIn) return; // 防止回车/连点重复提交
    setLoggingIn(true);
    setLoginError('');
    try {
      setUser(await login(name));
    } catch (err) {
      setLoginError(err instanceof Error ? `登录失败: ${err.message}` : '登录失败，请重试');
    } finally {
      setLoggingIn(false);
    }
  };

  // 切换用户：清空聊天状态并回到登录界面（socket 由 hook 内 effect 的 cleanup 断开）
  const switchUser = () => {
    chat.reset();
    setSidebarOpen(false);
    setUser(null);
  };

  // 移动端抽屉：选中/进入房间后自动收起（失败时由侧边栏表单展示错误，保持展开）
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
      <Sidebar
        open={sidebarOpen}
        rooms={chat.rooms}
        currentRoomId={chat.currentRoomId}
        onSelectRoom={handleSelectRoom}
        onCreateRoom={handleCreateRoom}
        onJoinRoom={handleJoinRoom}
      />

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
            onClick={() => setSidebarOpen(true)}
          >
            <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px"
                 fill="var(--text)">
              <path
                d="M160-240q-17 0-28.5-11.5T120-280q0-17 11.5-28.5T160-320h640q17 0 28.5 11.5T840-280q0 17-11.5 28.5T800-240H160Zm0-200q-17 0-28.5-11.5T120-480q0-17 11.5-28.5T160-520h640q17 0 28.5 11.5T840-480q0 17-11.5 28.5T800-440H160Zm0-200q-17 0-28.5-11.5T120-680q0-17 11.5-28.5T160-720h640q17 0 28.5 11.5T840-680q0 17-11.5 28.5T800-640H160Z"/>
            </svg>
          </button>
          {chat.currentRoom && <span className="chat-header-title">{chat.currentRoom.name}</span>}
        </div>

        {chat.currentRoomId === null ? (
          <div className="empty-state">选择或创建一个聊天室开始聊天</div>
        ) : (
          <MessageList
            key={chat.currentRoomId}
            myId={user.id}
            messages={chat.messages}
            hasMore={chat.hasMore}
            loadingOlder={chat.loadingOlder}
            onLoadOlder={chat.loadOlder}
          />
        )}

        <ChatInput
          username={user.username}
          disabled={chat.currentRoomId === null}
          connError={chat.connError}
          roomError={chat.roomError}
          onSend={chat.sendMessage}
          onSwitchUser={switchUser}
        />

      </div>
    </>
  );
}

export default App
