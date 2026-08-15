// 列设置（下拉勾选显隐 + 恢复默认）——2026-08-11，管理后台表格统一（个人偏好，localStorage 持久化）
import { Button, Checkbox, Dropdown } from 'antd';
import { SettingOutlined, ReloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { colVisible, type ColPref } from './useColPrefs';

export default function ColumnSettings({ defs, colPrefs, onToggle, onReset }: {
  defs: { key: string; title: string }[];
  colPrefs: Record<string, ColPref>;
  onToggle: (key: string) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Dropdown trigger={['click']}
        menu={{
          onClick: (info) => info.domEvent.stopPropagation(),
          items: defs.map((c) => ({
            key: c.key,
            label: (
              <Checkbox checked={colVisible(colPrefs, c.key)} onChange={() => onToggle(c.key)} style={{ width: '100%' }}>
                {c.title}
              </Checkbox>
            ),
          })),
        }}>
        <Button icon={<SettingOutlined />}>{t('table.columnSettings')}</Button>
      </Dropdown>
      <Button icon={<ReloadOutlined />} onClick={onReset}>{t('table.restoreColumns')}</Button>
    </>
  );
}
