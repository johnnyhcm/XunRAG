// 问答路由（管理后台左栏子菜单 → 页内 Tab：主题/意图/流程/对接人）——2026-08-11 拆分
import { useState } from 'react';
import { Tabs, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import DictTable from '../../components/config/DictTable';

export default function ConfigRoutesPage() {
  const { t } = useTranslation();
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 4 }}>{t('config.routesTitle')}</h2>
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>{t('config.routesSubtitle')}</Typography.Text>
      <Tabs
        items={[
          { key: 'topics', label: t('config.routes.topics'), children: <DictTable name="topics" onChanged={() => setReloadKey((k) => k + 1)} /> },
          { key: 'intents', label: t('config.routes.intents'), children: <DictTable name="intents" onChanged={() => setReloadKey((k) => k + 1)} /> },
          { key: 'processes', label: t('config.routes.processes'), children: <DictTable name="processes" onChanged={() => setReloadKey((k) => k + 1)} /> },
          { key: 'routes', label: t('config.routes.routes'), children: <DictTable name="routes" onChanged={() => setReloadKey((k) => k + 1)} /> },
        ]}
      />
    </div>
  );
}
