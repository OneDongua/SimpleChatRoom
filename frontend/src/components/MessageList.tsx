import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ChatMessage } from '../socket/socket.ts';

const TOP_TRIGGER_PX = 120; // 距顶部小于该值触发加载更早消息
const STICK_BOTTOM_PX = 120; // 距底部小于该值视为"贴底"

interface Props {
  myId: number;
  messages: ChatMessage[];
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}

/**
 * 消息列表（滚动容器是 window）：
 * - 新消息到达且原本贴底时自动滚到底；
 * - 向上滚动到顶部附近加载更早消息，prepend 后按高度差补偿视口，画面不跳。
 * 父组件用 key={roomId} 重挂载本组件，切换房间时所有滚动状态自然重置。
 */
export default function MessageList({ myId, messages, hasMore, loadingOlder, onLoadOlder }: Props) {
  const onLoadOlderRef = useRef(onLoadOlder);
  useEffect(() => {
    onLoadOlderRef.current = onLoadOlder;
  });

  const stickRef = useRef(true); // 是否贴底（滚动监听里更新）
  const measureRef = useRef(0); // 上一次 commit 后的 scrollHeight
  const firstIdRef = useRef<number | null>(null); // 上一次 commit 的首条 id（判定 prepend）
  const mountedRef = useRef(false);

  // 滚动监听只注册一次；onLoadOlder 用 ref 保持最新
  useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement;
      stickRef.current = doc.scrollHeight - window.scrollY - window.innerHeight < STICK_BOTTOM_PX;
      if (window.scrollY < TOP_TRIGGER_PX) onLoadOlderRef.current();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // 每次 commit 后测量：prepend 用高度差补偿视口；首次挂载/贴底时滚到底
  useLayoutEffect(() => {
    const doc = document.documentElement;
    const firstId = messages[0]?.id ?? null;
    const isPrepend =
      mountedRef.current && firstIdRef.current !== null && firstId !== firstIdRef.current;
    const wasMounted = mountedRef.current;

    const currentTop = window.scrollY;
    const prevHeight = measureRef.current;
    mountedRef.current = true;
    firstIdRef.current = firstId;
    measureRef.current = doc.scrollHeight;

    if (isPrepend) {
      const delta = doc.scrollHeight - prevHeight; // prepend 撑高的像素
      if (delta > 0) window.scrollTo(0, currentTop + delta);
      return;
    }
    if (!wasMounted || stickRef.current) window.scrollTo(0, doc.scrollHeight);
  }, [messages]);

  // 移动端键盘弹出后自动滚到底部
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const doc = document.documentElement;
    // 记录"无键盘"时的 visualViewport 高度基准
    let baseHeight = viewport.height;
    let keyboardOpen = false;

    const onResize = () => {
      const h = viewport.height;

      const diff = baseHeight - h;
      // 阈值：至少 150px 且超过基准高度的 15%，排除工具栏（约 50~100px）
      const threshold = Math.max(150, baseHeight * 0.15);

      if (!keyboardOpen && diff > threshold) {
        keyboardOpen = true;
        window.scrollTo(0, doc.scrollHeight);
      } else if (keyboardOpen && diff <= threshold) {
        // 键盘收起
        keyboardOpen = false;
        baseHeight = h;
      }
    };

    viewport.addEventListener("resize", onResize);

    return () => {
      viewport.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div className="message-list">
      <div className="history-hint">
        {loadingOlder
          ? '加载中…'
          : hasMore
            ? '向上滚动加载更早的消息'
            : messages.length > 0
              ? '没有更早的消息了'
              : ''}
      </div>
      {messages.map((message) => (
        <div
          key={message.id}
          className={message.senderId === myId ? 'message is-own' : 'message is-other'}
        >
          <div className="message-sender">{message.senderId === myId ? '我' : message.username}</div>
          {message.text}
        </div>
      ))}
    </div>
  );
}
