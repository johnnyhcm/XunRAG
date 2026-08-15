// 模型接入（管理后台左栏子菜单 → 单页：云端/本地 Segmented + 顶部 AI 灯）——2026-08-11 拆分
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ConfigStatusLights from '../../components/config/ConfigStatusLights';
import ModelConfigTab from '../../components/config/ModelConfigTab';

export default function ModelConfigPage() {
  const { t } = useTranslation();
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 8 }}>{t('console.configModel')}</h2>
      <ConfigStatusLights />
      <ModelConfigTab onChanged={() => setReloadKey((k) => k + 1)} />
    </div>
  );
}
