// 用户属性（管理后台左栏子菜单 → 单页：选项字段）——2026-08-11 拆分
import { useTranslation } from 'react-i18next';
import FieldDictsTab from '../../components/config/FieldDictsTab';

export default function FieldDictsPage() {
  const { t } = useTranslation();
  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 8 }}>{t('console.configFields')}</h2>
      <FieldDictsTab />
    </div>
  );
}
