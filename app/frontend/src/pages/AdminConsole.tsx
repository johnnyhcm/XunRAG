// 管理后台框架（2026-08-07，PRD §4.1.6）
// 左侧导航树 + 右侧内容（经典后台布局）；菜单 = 功能权限的可见体现（S6 联动）
// 2026-08-08 权限守卫：①/console 默认页按第一个有权限的菜单重定向（原 index 写死 UserManage，无 user_mgmt 权限也渲染）；
//   ②当前子路由无权限 → 重定向到有权限菜单；③完全无任何管理功能 → 显示无权限提示（后端 403 兜底）
import { useEffect } from 'react';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { Layout, Menu, Typography, Result } from 'antd';
import { TeamOutlined, ApartmentOutlined, SettingOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useMyPerms } from '../lib/useMyPerms';

const { Sider, Content } = Layout;

// 2026-08-11：系统配置展开为子菜单（问答配置/问答路由/模型接入/用户属性）——1 级左栏 + 2 级页内 Tab；子项权限继承父级 config_mgmt
// 2026-08-13：菜单 label 走 i18n（console.*），函数式构建以随语言切换重渲染
export default function AdminConsole() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const perm = useMyPerms(); // S6：菜单按功能权限过滤（系统管理员全见）
  const MENU = [
    { key: '/console/users', icon: <TeamOutlined />, label: t('console.users'), fn: 'user_mgmt' },
    { key: '/console/groups', icon: <ApartmentOutlined />, label: t('console.groups'), fn: 'role_mgmt' },
    {
      key: '/console/config', icon: <SettingOutlined />, label: t('console.config'), fn: 'config_mgmt',
      children: [
        { key: '/console/config/params', label: t('console.configParams'), fn: 'config_mgmt' },
        { key: '/console/config/routes', label: t('console.configRoutes'), fn: 'config_mgmt' },
        { key: '/console/config/model', label: t('console.configModel'), fn: 'config_mgmt' },
        { key: '/console/config/fields', label: t('console.configFields'), fn: 'config_mgmt' },
        { key: '/console/config/security', label: t('console.configSecurity'), fn: 'config_mgmt' },
      ],
    },
  ];
  const allowed = perm?.isSystemAdmin ? MENU : MENU.filter((m) => perm?.functions?.includes(m.fn));
  // 叶子菜单项（含子菜单展开）
  const allowedLeaves = allowed.flatMap((m) => (m.children?.length ? m.children : [m]));

  // 权限守卫（2026-08-08；2026-08-11 适配子菜单）：perm 加载后执行
  useEffect(() => {
    if (!perm) return; // useMyPerms 异步，未加载完不跳（避免误判）
    const allLeaves = MENU.flatMap((m) => (m.children?.length ? m.children : [m]));
    const currentLeaf = allLeaves.find((m) => location.pathname.startsWith(m.key));
    const first = allowedLeaves[0];
    // 情况1：直接访问 /console（index）或当前路径不在任何菜单 → 跳第一个有权限叶子
    if (!currentLeaf) { if (first && location.pathname !== first.key) navigate(first.key, { replace: true }); return; }
    // 情况2：当前子路由无权限 → 跳第一个有权限叶子（无则留在原地，渲染层显示无权限）
    if (!perm.isSystemAdmin && !perm.functions.includes(currentLeaf.fn)) {
      if (first) navigate(first.key, { replace: true });
    }
  }, [perm, location.pathname, navigate]);

  const selected = allowedLeaves.find((m) => location.pathname.startsWith(m.key))?.key ?? allowedLeaves[0]?.key ?? '';

  return (
    <Layout style={{ height: 'calc(100vh - 52px)', background: '#fff' }}>
      <Sider width={200} style={{ background: '#fafafa', borderRight: '1px solid #f0f0f0' }}>
        <Typography.Text strong style={{ display: 'block', padding: '16px 20px 8px', fontSize: 14 }}>{t('console.title')}</Typography.Text>
        <Menu
          mode="inline"
          selectedKeys={[selected]}
          defaultOpenKeys={['/console/config']}
          items={allowed}
          onClick={({ key }) => navigate(key)}
          style={{ background: 'transparent', borderInlineEnd: 'none' }}
        />
      </Sider>
      <Content style={{ minWidth: 0, overflow: 'auto' }}>
        {allowedLeaves.length === 0 ? (
          <Result status="403" title={t('console.noPerm')} subTitle={t('console.noPermSub')} />
        ) : (
          <Outlet />
        )}
      </Content>
    </Layout>
  );
}
