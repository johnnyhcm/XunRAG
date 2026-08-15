// session_id + 时区管理（PRD §3.1 / TECH.md §3.4）
// 不使用 zustand persist（避免异步 hydration 覆盖新 sessionId 导致历史混乱）
import { create } from 'zustand';

const STORAGE_KEY = 'policybot-session';

function readStorage(): { sessionId: string; timezone: string; userId?: string; token?: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { const v = JSON.parse(raw); return { sessionId: v.sessionId || '', timezone: v.timezone || '+08:00', userId: v.userId || undefined, token: v.token || undefined }; }
  } catch {}
  return { sessionId: '', timezone: '+08:00' };
}
function writeStorage(sessionId: string, timezone: string, userId: string | undefined, token?: string) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId, timezone, userId, token })); } catch {}
}

const UUID = (): string =>
  crypto.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

interface SessionState {
  sessionId: string;
  userId?: string;
  timezone: string;
  token?: string;
  ensure: () => string;
  newSession: () => string;
  setUserId: (id?: string) => void;
  setToken: (t?: string) => void;
}

// 启动时同步读 localStorage（无异步竞争）
const initial = readStorage();

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessionId: initial.sessionId,
  userId: initial.userId, // 未登录不设（无 token 无 userId → 后端匿名 → 登录页）；测试模式显式设置
  timezone: initial.timezone,
  token: initial.token,
  ensure: () => {
    const cur = get().sessionId;
    if (cur) return cur;
    const id = UUID();
    set({ sessionId: id });
    writeStorage(id, get().timezone, get().userId, get().token); // token 必须透传（否则抹掉 localStorage 的 token，2026-08-07）
    return id;
  },
  newSession: () => {
    const id = UUID();
    set({ sessionId: id });
    writeStorage(id, get().timezone, get().userId, get().token); // token 必须透传（否则抹掉 localStorage 的 token，2026-08-07）
    return id;
  },
  setUserId: (id?: string) => {
    set({ userId: id });
    writeStorage(get().sessionId || '', get().timezone, id, get().token);
  },
  setToken: (t?: string) => {
    set({ token: t });
    writeStorage(get().sessionId || '', get().timezone, get().userId, t);
  },
}));