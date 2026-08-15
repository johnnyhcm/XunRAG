// 界面语言切换器（2026-08-13，PRD §5.3 i18n）——登录页 + 设置菜单共用
// 切换写 localStorage（policybot-lang）+ changeLanguage 即时生效；
// 登录后档案语言不覆盖手动选择（见 i18n.ts applyProfileLanguage：手动切换过则尊重手动）
import { useTranslation } from 'react-i18next';
import { Segmented } from 'antd';
import { setAppLanguage } from '../i18n';

export default function LanguageSwitcher({ size = 'small' }: { size?: 'small' | 'middle' | 'large' }) {
  const { i18n } = useTranslation();
  const isZh = (i18n.language ?? '').startsWith('zh');
  return (
    <Segmented
      size={size}
      value={isZh ? 'zh' : 'en'}
      options={[
        { value: 'zh', label: '中文' },
        { value: 'en', label: 'English' },
      ]}
      onChange={(v) => setAppLanguage(v === 'zh' ? 'zh-CN' : 'en-US')}
    />
  );
}
