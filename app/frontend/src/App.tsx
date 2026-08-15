// 路由结构（线框图页面流转）
// /              AI 问答首页（WF-01 空状态占位）
// /policy/:id    政策全文阅读（WF-06 占位）
// /admin         政策管理（WF-08 占位）
// /history/:id   历史会话查看（WF-03.6 占位）
import { Routes, Route, Navigate } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import HomePage from './pages/HomePage';
import PolicyReadPage from './pages/PolicyReadPage';
import AdminPage from './pages/AdminPage';
import StatsPage from './pages/StatsPage';
import UserManage from './pages/UserManage';
import GroupsPage from './pages/GroupsPage';
import AdminConsole from './pages/AdminConsole';
import ConfigParamsPage from './pages/config/ConfigParamsPage';
import ConfigRoutesPage from './pages/config/ConfigRoutesPage';
import ModelConfigPage from './pages/config/ModelConfigPage';
import FieldDictsPage from './pages/config/FieldDictsPage';
import SecurityPage from './pages/config/SecurityPage';
import HistoryViewPage from './pages/HistoryViewPage';
import LoginPage from './pages/LoginPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<MainLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/policy/:id" element={<PolicyReadPage />} />
        <Route path="/policy/:id/:versionId" element={<PolicyReadPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/stats" element={<StatsPage />} />
        <Route path="/console" element={<AdminConsole />}>
          <Route index element={<></>} /> {/* 2026-08-08：默认页由 AdminConsole 按权限重定向到第一个有权限菜单（原写死 UserManage） */}
          <Route path="users" element={<UserManage />} />
          <Route path="groups" element={<GroupsPage />} />
          <Route path="config" element={<Navigate to="/console/config/params" replace />} /> {/* 2026-08-11：系统配置拆 4 子页，父级重定向 */}
          <Route path="config/params" element={<ConfigParamsPage />} />
          <Route path="config/routes" element={<ConfigRoutesPage />} />
          <Route path="config/model" element={<ModelConfigPage />} />
          <Route path="config/fields" element={<FieldDictsPage />} />
          <Route path="config/security" element={<SecurityPage />} />
        </Route>
        <Route path="/history/:sessionId" element={<HistoryViewPage />} />
        <Route path="*" element={<HomePage />} />
      </Route>
    </Routes>
  );
}