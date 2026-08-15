// API 客户端：统一带 X-Session-Id + X-User-Id header（TECH.md §3.4 / S4 方案 A）
// 2026-08-13：带 Accept-Language（当前界面语言）——后端错误文案/配置中心文案按语言输出（PRD §5.3 i18n）
import axios from 'axios';
import { useSessionStore } from '../store/session';
import i18n from '../i18n';

export const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use((cfg) => {
  const s = useSessionStore.getState();
  const sessionId = s.ensure();
  cfg.headers['X-Session-Id'] = sessionId;
  cfg.headers['Accept-Language'] = i18n.language ?? 'zh-CN';
  // S6 登录态：有 token 时带 Authorization（服务端优先用登录身份）；否则 demo 模式 X-User-Id 降级
  if (s.token) cfg.headers['Authorization'] = `Bearer ${s.token}`;
  else if (s.userId) cfg.headers['X-User-Id'] = s.userId;
  return cfg;
});

// 带身份/会话头的 fetch（2026-08-08：原生 fetch 不带身份头 → 服务端匿名 → 拒答（HomePage/HistoryView 提问、configs 加载均受影响）；统一走此 helper）
// 2026-08-13：同步带 Accept-Language
export function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const s = useSessionStore.getState();
  const headers: Record<string, string> = {
    'X-Session-Id': s.ensure(),
    'Accept-Language': i18n.language ?? 'zh-CN',
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (s.token) headers['Authorization'] = `Bearer ${s.token}`;
  else if (s.userId) headers['X-User-Id'] = s.userId;
  return fetch(url, { ...options, headers });
}