// 顶部栏（PRD §5.5 准则 2：层级对称；准则 6：标题只一次）
// 登录态（S6 完整版，2026-08-07）：有 token 显示登录用户 + 退出；测试模式（demo，X-User-Id）显示"测试：X" + 退出；
// 未登录 → 路由守卫已在 MainLayout 跳登录页（本组件不会在未登录态渲染）
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Dropdown } from 'antd';
import { SettingOutlined, ReadOutlined, FileTextOutlined, DashboardOutlined, BarChartOutlined, LogoutOutlined, PlusOutlined, MoreOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../store/session';
import { Users, Auth, type UserRow } from '../lib/policy-api';
import { api } from '../lib/api';
import { fetchAppTitle } from '../lib/appTitle';
import { useMyPerms } from '../lib/useMyPerms';

interface Props {
  onToggleHistory: () => void;
  onTogglePolicy: () => void;
  onOpenAdmin: () => void;
  onOpenConsole: () => void;
  onToggleSettings: () => void;
  onNewChat?: () => void;
  settingsOpen: boolean;
}

export default function TopBar({ onToggleHistory, onTogglePolicy, onOpenAdmin, onOpenConsole, onToggleSettings, settingsOpen, onNewChat }: Props) {
  const { t } = useTranslation();
  const userId = useSessionStore((s) => s.userId);
  const setUserId = useSessionStore((s) => s.setUserId);
  const token = useSessionStore((s) => s.token);
  const setToken = useSessionStore((s) => s.setToken);
  const [users, setUsers] = useState<UserRow[]>([]);
  // 2026-08-11：demo 测试身份仅在 AUTH_MODE=demo 时显示（X-User-Id 已默认关闭）
  const [authMode, setAuthMode] = useState<string | null>(null);
  // 2026-08-11：顶栏产品名读配置 common.home.title（与首页欢迎区一致，企业可定制品牌名）
  const [appTitle, setAppTitle] = useState('企业政策 AI');
  const perm = useMyPerms(); // S6：按权限渲染入口（后端 403 兜底）
  const navigate = useNavigate();
  const canPolicy = perm?.isSystemAdmin || perm?.functions?.includes('policy_mgmt') || perm?.functions?.includes('policy_library_mgmt') || false;
  // 管理后台入口：系统管理员 或 持有任一系统级功能（用户管理/权限角色管理/系统配置）——2026-08-08 放开（PRD §3.3 功能可分勾）
  const canConsole = perm?.isSystemAdmin || ['user_mgmt', 'role_mgmt', 'config_mgmt'].some((f) => perm?.functions?.includes(f)) || false;
  // 统计报表：独立功能 stats_view（2026-08-09：顶栏一级入口 /stats，与管理后台平级）
  const canStats = perm?.isSystemAdmin || perm?.functions?.includes('stats_view') || false;

  useEffect(() => {
    Users.list({ status: 'active' }).then(({ users: list }) => setUsers(list)).catch(() => {});
    api.get('/me').then((r) => setAuthMode(r.data?.authMode ?? 'production')).catch(() => setAuthMode('production'));
    // 2026-08-11：产品名读配置 common.home.title（链接文字 + 浏览器标签页标题统一）
    fetchAppTitle().then(setAppTitle).catch(() => {});
  }, []);

  const current = useMemo(() => users.find((u) => u.id === userId), [users, userId]);

  const logout = async () => {
    try { await Auth.logout(); } catch { /* token 可能已失效 */ }
    setToken(undefined);
    setUserId(undefined); // 测试模式也退出
    navigate('/login');
  };

  const loginLabel = token
    ? t('nav.loggedIn', { name: perm?.user?.name ?? '' })
    : (authMode === 'demo' && current ? t('nav.testMode', { name: current.name }) : '');

  return (
    <header className="topbar">
      <div className="topbar-left">
        <Button type="text" onClick={onToggleHistory} aria-label={t('nav.history')}>☰</Button>
        <Link to="/" className="topbar-title">{appTitle}</Link>
        <Button type="text" icon={<PlusOutlined />} onClick={onNewChat} aria-label={t('nav.newChat')}>{t('nav.newChat')}</Button>
      </div>
      <div className="topbar-right">
        {/* 2026-08-11：手机适配——次要入口平铺（桌面 .topbar-extra）/ 折叠「更多」（手机 .topbar-more） */}
        <div className="topbar-extra">
          {loginLabel && <span style={{ fontSize: 13, color: '#555' }}>{loginLabel}</span>}
          {(token || current) && (
            <Button type="text" icon={<LogoutOutlined />} onClick={logout}>{t('nav.logout')}</Button>
          )}
          <Button type="text" icon={<ReadOutlined />} onClick={onTogglePolicy}>{t('nav.browse')}</Button>
          {canPolicy && <Button type="text" icon={<FileTextOutlined />} onClick={onOpenAdmin}>{t('nav.admin')}</Button>}
          {canConsole && <Button type="text" icon={<DashboardOutlined />} onClick={onOpenConsole}>{t('nav.console')}</Button>}
          {canStats && <Button type="text" icon={<BarChartOutlined />} onClick={() => navigate('/stats')}>{t('nav.stats')}</Button>}
        </div>
        <Dropdown trigger={['click']} className="topbar-more"
          menu={{ items: [
            ...(loginLabel ? [{ key: 'login', label: loginLabel, disabled: true }] : []),
            { key: 'policy', icon: <ReadOutlined />, label: t('nav.browse'), onClick: onTogglePolicy },
            ...(canPolicy ? [{ key: 'admin', icon: <FileTextOutlined />, label: t('nav.admin'), onClick: onOpenAdmin }] : []),
            ...(canConsole ? [{ key: 'console', icon: <DashboardOutlined />, label: t('nav.console'), onClick: onOpenConsole }] : []),
            ...(canStats ? [{ key: 'stats', icon: <BarChartOutlined />, label: t('nav.stats'), onClick: () => navigate('/stats') }] : []),
            ...(token || current ? [{ key: 'logout', icon: <LogoutOutlined />, label: t('nav.logout'), danger: true, onClick: logout }] : []),
          ] }}>
          <Button type="text" icon={<MoreOutlined />} aria-label={t('nav.more')} />
        </Dropdown>

        <Button
          type="text"
          aria-label={t('nav.settings')}
          icon={<SettingOutlined />}
          onClick={(e) => { e.stopPropagation(); onToggleSettings(); }}
          className={settingsOpen ? 'active' : ''}
        />
      </div>
    </header>
  );
}
