import { useEffect, useState } from 'react';

/** 错误提示的展示时长；需与 App.css 中 form-error-in-out 动画时长保持一致 */
const ERROR_VISIBLE_MS = 5000;

/**
 * 表单错误状态：用法同 useState，但设置后会在 5 秒自动清空。
 * 清空即触发条件渲染卸载（配合 CSS 动画淡出），错误占用的布局也随之恢复。
 */
export function useFormError() {
  const [error, setError] = useState('');

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(''), ERROR_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [error]);

  return [error, setError] as const;
}
