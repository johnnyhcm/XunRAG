// 全局布局（线框图"全局布局" + PRD §5.5 准则 2：层级对称）
// 顶部栏一级入口：☰ 历史 / 浏览政策 / 政策管理 / ⚙ 设置（仅辅助项）
// 2026-08-07 登录守卫：未登录（无 token 且未选测试身份）→ 跳登录页；
//   带 token 时每次导航校验服务端真实身份（token 失效/被吊销 → 清 token 回登录页）——以服务端身份为准，避免"原页登录新页要登录"分裂
import { useState, useEffect } from 'react';
import { Outlet, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import TopBar from '../components/TopBar';
import HistorySidebar from '../components/HistorySidebar';
import PolicyDrawer from '../components/PolicyDrawer';
import SettingsMenu from '../components/SettingsMenu';
import ChangePassword from '../components/ChangePassword';
import { Me } from '../lib/policy-api';
import { useMyPerms } from '../lib/useMyPerms';

import { useSessionStore } from '../store/session';

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatKey, setChatKey] = useState(0);
  const [pwOpen, setPwOpen] = useState(false); // 常规改密（⚙ 入口）
  const [forcePwOpen, setForcePwOpen] = useState(false); // 首次登录强制改密（不可关闭）
  const newSession = useSessionStore((s) => s.newSession);
  const token = useSessionStore((s) => s.token);
  const setToken = useSessionStore((s) => s.setToken);
  const userId = useSessionStore((s) => s.userId);
  const perm = useMyPerms(); // 含 forcePasswordChange（2026-08-09）

  // 首次登录强制改密（2026-08-09）：/me 返回 forcePasswordChange=true（must_change_password=1 && 配置开启）→ 弹不可关闭改密框
  useEffect(() => {
    if (perm?.forcePasswordChange) setForcePwOpen(true);
  }, [perm?.forcePasswordChange]);

  // 登录守卫：无 token 且无测试身份 → 登录页（未登录不再以 admin 进入）
  useEffect(() => {
    if (!token && !userId) { navigate('/login', { replace: true }); return; }
    // 带 token → 校验服务端真实身份（每次导航触发）：token 失效/被吊销（如管理员清空会话、过期）→ 清 token → 回登录页
    if (token) {
      Me.get().then((p) => { if (!p.user) setToken(undefined); }).catch(() => { /* 网络异常不误踢 */ });
    }
  }, [token, userId, navigate, location.pathname]);

  // ?new=1 触发新对话（来自历史页「重新提问」）
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setChatKey((k) => k + 1);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // 政策管理是独立页，不是抽屉
  const goAdmin = () => {
    setSettingsOpen(false);
    navigate('/admin');
  };
  const goConsole = () => {
    setSettingsOpen(false);
    navigate('/console');
  };

  const newChat = () => {
    newSession(); // 生成新 sessionId
    setChatKey((k) => k + 1);
    navigate('/');
  };

  return (
    <div className="layout">
      <TopBar
        onToggleHistory={() => setHistoryOpen((v) => !v)}
        onTogglePolicy={() => setPolicyOpen((v) => !v)}
        onOpenAdmin={goAdmin}
        onOpenConsole={goConsole}
        onToggleSettings={() => setSettingsOpen((v) => !v)}
        settingsOpen={settingsOpen}
        onNewChat={newChat}
      />
      <main className="content" onClick={() => settingsOpen && setSettingsOpen(false)}>
        <div key={chatKey} style={{ height: '100%' }}><Outlet /></div>
      </main>

            <HistorySidebar
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onOpenHistory={(id) => navigate(`/history/${id}`)}
      />
      <PolicyDrawer
        open={policyOpen}
        onClose={() => setPolicyOpen(false)}
        onOpenPolicy={(id) => window.open(`/policy/${id}`, '_blank')} // 2026-08-07：与管理员端一致，新标签页打开（保留浏览列表、可对比）
      />
      <SettingsMenu open={settingsOpen} onClose={() => setSettingsOpen(false)} onOpenChangePassword={() => setPwOpen(true)} />
      {/* 常规改密：⚙ 个人设置入口 */}
      <ChangePassword open={pwOpen} force={false} onClose={() => setPwOpen(false)} />
      {/* 强制改密：首次登录（must_change_password=1 且配置开启）——不可关闭；成功后关闭（内存 perm 仍为 true，刷新后 /me 已清零） */}
      <ChangePassword open={forcePwOpen} force onClose={() => setForcePwOpen(false)} onChanged={() => setForcePwOpen(false)} />
    </div>
  );
}