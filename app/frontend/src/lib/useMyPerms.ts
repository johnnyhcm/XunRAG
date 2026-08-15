// 我的权限 hook（S6 前端渲染联动，PRD §3.3 ④）：跟随当前身份（X-User-Id）拉取 /api/me
// 切换身份自动重新拉取；失败（后端未就绪/401 等）置空 → 前端隐藏管理入口（后端 403 兜底安全）
// 2026-08-13：/me 返回 user.language（BCP47）→ applyProfileLanguage 应用档案语言（用户手动切换过则尊重手动）
import { useEffect, useState } from 'react';
import { useSessionStore } from '../store/session';
import { Me, type MyPerm } from './policy-api';
import { applyProfileLanguage } from '../i18n';

export function useMyPerms(): MyPerm | null {
  const userId = useSessionStore((s) => s.userId);
  const token = useSessionStore((s) => s.token);
  const setToken = useSessionStore((s) => s.setToken);
  const [perm, setPerm] = useState<MyPerm | null>(null);
  useEffect(() => {
    let alive = true;
    Me.get().then((p) => {
      if (!alive) return;
      setPerm(p);
      applyProfileLanguage(p.user?.language);
      // token 失效检测（2026-08-07）：带了 token 但后端返回匿名（如管理员清空 sessions / token 过期）→ 清除 token 回登录页
      if (token && !p.user) setToken(undefined);
    }).catch(() => alive && setPerm(null));
    return () => { alive = false; };
  }, [userId, token, setToken]); // token 变化（登录/登出/失效）也刷新——登录后身份来自 token
  return perm;
}
