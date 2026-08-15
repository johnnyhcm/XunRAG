// 模型接入共享常量（provider 预设）——2026-08-11 从 ConfigPage 拆出
// 2026-08-13：label 走 i18n（config.provider.*）；custom 为中文标注，英文界面显示英文
export const PROVIDER_OPTIONS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'custom', label: '自定义（OpenAI 兼容）' },
];
/** provider 显示名（locale 感知：custom 本地化，其余品牌名不变） */
export function providerLabel(t: (k: string, o?: any) => string, value: string): string {
  if (value === 'custom') return t('config.provider.custom', { defaultValue: '自定义（OpenAI 兼容）' });
  return PROVIDER_OPTIONS.find((p) => p.value === value)?.label ?? value;
}
export const PROVIDER_DEFAULT_URL: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  deepseek: 'https://api.deepseek.com',
  custom: '',
};
