import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, Room, RoomInfo, UnreadUpdate, User } from '../socket/socket.ts';
import { connectAs, socket } from '../socket/socket.ts';
import { createRoom, fetchMessages, joinRoom, listRooms } from '../api.ts';

const PAGE_SIZE = 50;

/** 按 id 升序合并两组消息（去重） */
function mergeById(a: ChatMessage[], b: ChatMessage[]): ChatMessage[] {
  const map = new Map<number, ChatMessage>();
  for (const message of a) map.set(message.id, message);
  for (const message of b) map.set(message.id, message);
  return [...map.values()].sort((x, y) => x.id - y.id);
}

/** 与服务端 ORDER BY 一致：公共房在前，同组按 id 升序 */
function sortRooms(rooms: RoomInfo[]): RoomInfo[] {
  return [...rooms].sort((a, b) => Number(b.isPublic) - Number(a.isPublic) || a.id - b.id);
}

/** 插入或替换房间并保持排序 */
function upsertRoom(rooms: RoomInfo[], room: RoomInfo): RoomInfo[] {
  return sortRooms([...rooms.filter((r) => r.id !== room.id), room]);
}

export interface ChatApi {
  rooms: RoomInfo[];
  currentRoom: RoomInfo | null;
  currentRoomId: number | null;
  messages: ChatMessage[];
  hasMore: boolean;
  loadingOlder: boolean;
  /** 进房/拉历史/发送失败的提示（显示在输入框上方） */
  roomError: string;
  /** socket 连接失败提示 */
  connError: string;
  selectRoom: (roomId: number) => void;
  createRoomAndEnter: (name: string, isPublic: boolean, password?: string) => Promise<void>;
  joinRoomById: (roomId: number, password?: string) => Promise<void>;
  sendMessage: (text: string) => void;
  loadOlder: () => void;
  reset: () => void;
}

/**
 * 聊天室核心状态：房间列表、当前房间、消息与 socket 生命周期。
 * 登录后调用（user 为 null 时不做任何事），切换用户前调用 reset()。
 */
export function useChatSocket(user: User | null, token: string | null): ChatApi {
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [currentRoomId, setCurrentRoomId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [roomError, setRoomError] = useState('');
  const [connError, setConnError] = useState('');

  // 同步镜像：socket 回调与 effect 里读取，避免把可变值放进依赖数组
  const currentRoomIdRef = useRef<number | null>(null);
  const loadingOlderRef = useRef(false);

  const selectRoom = useCallback((roomId: number | null) => {
    if (roomId === currentRoomIdRef.current) return;
    currentRoomIdRef.current = roomId; // 先同步 ref：onMessage 过滤、重连重进都读它
    setCurrentRoomId(roomId);
    setMessages([]);
    setHasMore(false);
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    setRoomError('');
    if (roomId !== null) {
      // 进房即已读：本地立刻清零不等服务端（服务端在 room:enter 里落库并广播给其它标签页）
      setRooms((prev) => prev.map((r) => (r.id === roomId ? { ...r, unreadCount: 0 } : r)));
    }
  }, []);

  /** 拉最新一页：replace=true 用于进房；false 用于重连补齐（按 id 合并，不动 hasMore） */
  const loadLatest = useCallback(
    async (roomId: number, replace: boolean) => {
      if (!user) return;
      const page = await fetchMessages(roomId, { limit: PAGE_SIZE });
      if (currentRoomIdRef.current !== roomId) return; // 期间已切房，丢弃
      if (replace) {
        setMessages(page.messages);
        setHasMore(page.hasMore);
      } else {
        setMessages((prev) => mergeById(prev, page.messages));
      }
    },
    [user],
  );

  /** 请求服务端把本连接加入房间频道（幂等）；成功后拉取/补齐消息 */
  const enterRoomOnServer = useCallback(
    (roomId: number, replace: boolean) => {
      socket.emit('room:enter', roomId, (result) => {
        if (currentRoomIdRef.current !== roomId) return; // 过期 ack（已切房）
        if (!result.ok) {
          selectRoom(null);
          setRoomError(result.error);
          return;
        }
        setRooms((prev) => upsertRoom(prev, result.room));
        void loadLatest(roomId, replace).catch((err) => {
          if (currentRoomIdRef.current !== roomId) return;
          setRoomError(err instanceof Error ? err.message : '加载历史消息失败');
        });
      });
    },
    [loadLatest, selectRoom],
  );

  // 把"进房函数"放进 ref：让 [user] effect 的依赖保持只有 [user]，避免每次渲染重连 socket
  const enterRoomOnServerRef = useRef(enterRoomOnServer);
  useEffect(() => {
    enterRoomOnServerRef.current = enterRoomOnServer;
  });

  // Effect A —— 只依赖 [user, token]：连接 + 全部监听
  useEffect(() => {
    if (!user) return;
    let disposed = false; // effect 卸载（切换用户）后丢弃在途的房间列表响应

    const onConnect = () => {
      setConnError('');
      const roomId = currentRoomIdRef.current;
      if (roomId !== null) enterRoomOnServerRef.current(roomId, false); // 首连/重连后重进房并补齐断线消息
      // 断线期间的 unread 推送收不到，重连后重拉房间列表补齐；
      // 当前房强制置 0：HTTP 快照可能早于 room:enter 的已读落库，避免把旧未读写回
      void listRooms()
        .then((list) => {
          if (disposed) return;
          const current = currentRoomIdRef.current;
          setRooms(sortRooms(list.map((r) => (r.id === current ? { ...r, unreadCount: 0 } : r))));
        })
        .catch(() => {}); // 静默：保留旧列表，后续 unread 事件会继续更新
    };
    const onConnectError = (err: Error) => {
      console.error('socket 连接失败：', err.message);
      setConnError(`连接失败：${err.message}`);
    };
    const onMessage = (message: ChatMessage) => {
      if (message.roomId !== currentRoomIdRef.current) return; // 切房瞬间的旧房消息丢弃
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    };
    const onRoomCreated = (room: Room) => {
      setRooms((prev) => upsertRoom(prev, { ...room, isMember: room.creatorId === user.id, unreadCount: 0 }));
    };
    const onUnread = (update: UnreadUpdate) => {
      if (update.roomId === currentRoomIdRef.current) return; // 当前房恒已读（本地已清零），忽略
      setRooms((prev) =>
        prev.map((r) => (r.id === update.roomId ? { ...r, unreadCount: update.unreadCount } : r)),
      );
    };

    // 先挂监听再 connect，避免握手后立刻到达的消息丢失
    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
    socket.on('message', onMessage);
    socket.on('room:created', onRoomCreated);
    socket.on('unread', onUnread);
    if (token) connectAs(token);

    return () => {
      disposed = true;
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
      socket.off('message', onMessage);
      socket.off('room:created', onRoomCreated);
      socket.off('unread', onUnread);
      socket.disconnect();
    };
  }, [user, token]);

  // Effect B —— [user, currentRoomId]：切房时 leave 旧 / enter 新
  useEffect(() => {
    if (!user || currentRoomId === null) return;
    if (socket.connected) {
      enterRoomOnServerRef.current(currentRoomId, true);
    }
    // 未连接时不 emit：connect 处理器会补发，避免 sendBuffer 缓存造成双进房
    return () => {
      if (socket.connected) socket.emit('room:leave', currentRoomId);
    };
  }, [user, currentRoomId]);

  // 登录后加载可见房间列表（不自动进房）
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    listRooms()
      .then((list) => {
        if (!cancelled) setRooms(sortRooms(list));
      })
      .catch((err) => {
        if (!cancelled) setRoomError(err instanceof Error ? err.message : '加载聊天室列表失败');
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const createRoomAndEnter = useCallback(
    async (name: string, isPublic: boolean, password?: string) => {
      if (!user) return;
      // 公共房不发送 password 字段（后端拒绝公共房带密码）；私有房漏传则后端 400
      const input = isPublic
        ? { name, isPublic }
        : { name, isPublic, password };
      const room = await createRoom(input); // 失败即抛，由表单展示
      setRooms((prev) => upsertRoom(prev, room));
      selectRoom(room.id);
    },
    [user, selectRoom],
  );

  const joinRoomById = useCallback(
    async (roomId: number, password?: string) => {
      if (!user) return;
      const room = await joinRoom(roomId, password); // 私有房在此获得成员身份
      setRooms((prev) => upsertRoom(prev, room));
      selectRoom(room.id);
    },
    [user, selectRoom],
  );

  const sendMessage = useCallback((text: string) => {
    const roomId = currentRoomIdRef.current;
    const body = text.trim();
    if (roomId === null || !body) return;
    socket.emit('message', { roomId, text: body }, (result) => {
      if (!result.ok) setRoomError(result.error ?? '发送失败');
    });
  }, []);

  const loadOlder = useCallback(async () => {
    if (!user || currentRoomId === null || loadingOlderRef.current || !hasMore) return;
    const before = messages[0]?.id;
    if (before === undefined) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const page = await fetchMessages(currentRoomId, { before, limit: PAGE_SIZE });
      if (currentRoomIdRef.current !== currentRoomId) return; // 期间已切房
      if (page.messages.length > 0) setMessages((prev) => mergeById(page.messages, prev));
      setHasMore(page.hasMore);
    } catch (err) {
      if (currentRoomIdRef.current === currentRoomId) {
        setRoomError(err instanceof Error ? err.message : '加载更早的消息失败');
      }
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [user, currentRoomId, hasMore, messages]);

  const reset = useCallback(() => {
    currentRoomIdRef.current = null;
    loadingOlderRef.current = false;
    setRooms([]);
    setCurrentRoomId(null);
    setMessages([]);
    setHasMore(false);
    setLoadingOlder(false);
    setRoomError('');
    setConnError('');
  }, []);

  const currentRoom = rooms.find((r) => r.id === currentRoomId) ?? null;

  return {
    rooms,
    currentRoom,
    currentRoomId,
    messages,
    hasMore,
    loadingOlder,
    roomError,
    connError,
    selectRoom,
    createRoomAndEnter,
    joinRoomById,
    sendMessage,
    loadOlder,
    reset,
  };
}
