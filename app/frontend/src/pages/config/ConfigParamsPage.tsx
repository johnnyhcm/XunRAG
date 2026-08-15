// 问答配置（管理后台左栏子菜单 → 页内 Tab：高效/智能/通用；顶部 AI 灯）——2026-08-11 拆分
import { useEffect, useState } from 'react';
import { Tabs } from 'antd';
import { useTranslation } from 'react-i18next';
import { authFetch } from '../../lib/api';
import ConfigCard, { sectionLabel, type ConfigItem } from '../../components/config/ConfigCard';
import ConfigStatusLights from '../../components/config/ConfigStatusLights';

export default function ConfigParamsPage() {
  const { t } = useTranslation();
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const load = () => authFetch('/api/configs').then((r) => r.json()).then((d) => setConfigs(d.configs ?? []));
  useEffect(() => { load(); }, [reloadKey]);

  const renderModule = (module: string) => {
    const items = configs.filter((c) => c.module === module);
    const sections = [...new Set(items.map((c) => c.section))];
    return (
      <div style={{ maxWidth: 760 }}>
        {sections.map((sec) => (
          <ConfigCard key={sec} title={sectionLabel(t, sec)}
            items={items.filter((c) => c.section === sec)} onSaved={() => load()} />
        ))}
      </div>
    );
  };

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 8 }}>{t('config.paramsTitle')}</h2>
      <ConfigStatusLights />
      <Tabs
        items={[
          { key: 'efficient', label: t('mode.efficientFull'), children: renderModule('efficient') },
          { key: 'smart', label: t('mode.smartFull'), children: renderModule('smart') },
          { key: 'common', label: t('config.common'), children: renderModule('common') },
        ]}
      />
    </div>
  );
}
