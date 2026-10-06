import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { RoomInfo } from '../socket/socket.ts';
import { useFormError } from '../hooks/useFormError.ts';

interface Props {
  /** 移动端抽屉是否展开（桌面端无效果） */
  open: boolean;
  rooms: RoomInfo[];
  currentRoomId: number | null;
  onSelectRoom: (roomId: number) => void;
  onCreateRoom: (name: string, isPublic: boolean, password?: string) => Promise<void>;
  onJoinRoom: (roomId: number, password?: string) => Promise<void>;
  canCreatePublic: boolean;
}

/** 侧边栏：品牌 + 创建/加入入口 + 公共/私有房间列表 */
export default function Sidebar({
                                  open,
                                  rooms,
                                  currentRoomId,
                                  onSelectRoom,
                                  onCreateRoom,
                                  onJoinRoom,
                                  canCreatePublic
                                }: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newIsPublic, setNewIsPublic] = useState(true);
  const [newPassword, setNewPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useFormError(); // 5 秒后自动消失
  const [joinId, setJoinId] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [joinFocused, setJoinFocused] = useState(false); // 聚焦加入表单时才展开密码行
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useFormError(); // 5 秒后自动消失
  const joinInputRef = useRef<HTMLInputElement>(null);

  const submitCreate = async (e: FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    if (!newIsPublic && !newPassword.trim()) return; // 私有房必须设置非空白密码
    setCreating(true);
    setCreateError('');
    try {
      // 发送原始密码（不 trim，空格是合法字符）；公共房不传该参数
      await onCreateRoom(name, newIsPublic, newIsPublic ? undefined : newPassword);
      setShowCreate(false);
      setNewName('');
      setNewIsPublic(true);
      setNewPassword('');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : '创建失败，请重试');
    } finally {
      setCreating(false);
    }
  };

  const submitJoin = async (e: FormEvent) => {
    e.preventDefault();
    const id = Number(joinId.trim());
    if (!Number.isInteger(id) || id <= 0 || joining) return;
    setJoining(true);
    setJoinError('');
    try {
      await onJoinRoom(id, joinPassword === '' ? undefined : joinPassword);
      setJoinId('');
      setJoinPassword('');
    } catch (err) {
      // 失败时保留密码，便于改错重试
      setJoinError(err instanceof Error ? err.message : '加入失败，请重试');
    } finally {
      setJoining(false);
    }
  };

  const publicRooms = rooms.filter((room) => room.isPublic);
  const privateRooms = rooms.filter((room) => !room.isPublic);

  useEffect(() => {
    if (joinError) joinInputRef.current?.focus();
  }, [joinError]);

  return (
    <aside className={`sidebar${open ? ' is-open' : ''}`}>

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

      <button
        className={`room-create-btn${showCreate ? ' is-expanded' : ''}`}
        onClick={() => {
          setShowCreate((v) => !v);
          if (!canCreatePublic) setNewIsPublic(false);
          setCreateError('');
        }}
      >
        {showCreate ? '取消创建' : '+ 创建聊天室'}
      </button>
      <form className={`room-create-form${showCreate ? ' is-expanded' : ''}`} onSubmit={submitCreate}>
        <input
          className="room-input"
          value={newName}
          maxLength={32}
          autoFocus
          placeholder="聊天室名称"
          data-testid="room-name-input"
          onChange={(e) => setNewName(e.target.value)}
        />
        {!newIsPublic && (
          <input
            className="room-input"
            type="password"
            value={newPassword}
            maxLength={64}
            placeholder="设置房间密码（必填）"
            data-testid="room-create-password"
            onChange={(e) => setNewPassword(e.target.value)}
          />
        )}
        <div className="room-form-row">
          <select
            className="room-visibility"
            value={newIsPublic ? 'public' : 'private'}
            data-testid="room-visibility"
            onChange={(e) => setNewIsPublic(e.target.value === 'public')}
          >
            {canCreatePublic && <option value="public">公共</option>}
            <option value="private">私有</option>
          </select>
          <button
            type="submit"
            disabled={!newName.trim() || creating || (!newIsPublic && !newPassword.trim())}
            data-testid="room-create-submit"
          >
            {creating ? '创建中…' : '创建'}
          </button>
        </div>
        {createError && <div className="room-form-error">{createError}</div>}
      </form>

      <form
        className="room-join-form"
        onSubmit={submitJoin}
        onFocus={() => setJoinFocused(true)}
        onBlur={(e) => {
          // blur 会冒泡：焦点仍在表单内（如移到密码框/按钮）时不收起
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setJoinFocused(false);
        }}
      >
        <div className="room-form-row">
          <input
            className="room-input"
            value={joinId}
            inputMode="numeric"
            placeholder="输入房间 ID 加入"
            data-testid="room-join-input"
            ref={joinInputRef}
            onChange={(e) => setJoinId(e.target.value)}
          />
          <button type="submit" disabled={!joinId.trim() || joining} data-testid="room-join-submit">
            {joining ? '加入中…' : '加入'}
          </button>
        </div>
        <div className={`room-form-row room-join-password-row${joinFocused ? ' is-expanded' : ''}`}>
          <input
            className="room-input"
            type="password"
            value={joinPassword}
            maxLength={64}
            placeholder="房间密码（私有）"
            data-testid="room-join-password"
            onChange={(e) => setJoinPassword(e.target.value)}
          />
        </div>
        {joinError && <div className="room-form-error">{joinError}</div>}
      </form>

      <div className="room-group-title">公共聊天室</div>
      <div className="list-item-container">
        {publicRooms.length === 0 && <div className="room-empty">暂无公共聊天室</div>}
        {publicRooms.map((room) => (
          <button
            key={room.id}
            type="button"
            className={`list-item${room.id === currentRoomId ? ' is-active' : ''}`}
            data-room-id={room.id}
            onClick={() => onSelectRoom(room.id)}
          >
            <span className="room-name">{room.name}</span>
            {room.isMember && room.unreadCount > 0 && (
              <span className="room-unread" title={`${room.unreadCount} 条未读`}>
                {room.unreadCount > 99 ? '99+' : room.unreadCount}
              </span>
            )}
            <span className="room-id">#{room.id}</span>
          </button>
        ))}
      </div>

      {privateRooms.length > 0 && (
        <>
          <div className="room-group-title">私有聊天室</div>
          <div className="list-item-container">
            {privateRooms.map((room) => (
              <button
                key={room.id}
                type="button"
                className={`list-item${room.id === currentRoomId ? ' is-active' : ''}`}
                data-room-id={room.id}
                onClick={() => onSelectRoom(room.id)}
              >
                <span className="room-name">{room.name}</span>
                {room.isMember && room.unreadCount > 0 && (
                  <span className="room-unread" title={`${room.unreadCount} 条未读`}>
                    {room.unreadCount > 99 ? '99+' : room.unreadCount}
                  </span>
                )}
                <span className="room-id">#{room.id}</span>
              </button>
            ))}
          </div>
        </>
      )}

    </aside>
  );
}
