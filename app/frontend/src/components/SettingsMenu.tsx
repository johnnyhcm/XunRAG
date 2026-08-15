// 设置菜单（⚙，PRD §4.1.6 归位个人设置）
// 系统级功能（AI 状态/政策管理/系统配置）已迁出：AI 状态 → 系统配置页顶部指示灯；政策管理/管理后台为独立入口
// 2026-08-13：界面语言切换已上线（共享 LanguageSwitcher，登录页 + 设置菜单共用）
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from './LanguageSwitcher';

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenChangePassword?: () => void;
}

export default function SettingsMenu({ open, onClose, onOpenChangePassword }: Props) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <>
      <div className="backdrop show" onClick={onClose} />
      <div className="settings-menu" onClick={(e) => e.stopPropagation()}>
        <div className="menu-section">
          <div className="menu-label">{t('settings.personal')}</div>
          <div
            className="menu-row clickable"
            onClick={() => { onOpenChangePassword?.(); onClose(); }}
          >
            {t('settings.changePassword')}
          </div>
          <div className="menu-row" style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, color: '#555' }}>{t('settings.language')}</span>
            <LanguageSwitcher />
          </div>
        </div>
        <div className="menu-divider" />
        <div className="menu-row muted">{t('settings.about', { version: 'v0.1.0' })}</div>
      </div>
    </>
  );
}
