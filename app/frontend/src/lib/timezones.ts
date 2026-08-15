// 时区工具（2026-08-13，PRD §4.2.3）——24 常用 IANA 时区，标签用 Intl 动态生成（CLDR 一致，零手工翻译表）
// 2026-08-13：语言跟随当前 UI locale（i18n.language），不再硬编码 zh-CN
import i18n from '../i18n';

export const TIMEZONES: string[] = [
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore',
  'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Kolkata', 'Asia/Dubai',
  'Europe/London', 'Europe/Berlin', 'Europe/Moscow', 'Europe/Istanbul',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Mexico_City',
  'America/Sao_Paulo', 'Australia/Sydney', 'Pacific/Auckland', 'Africa/Johannesburg',
];

/** 当前 UI 语言标签（Intl 用，如 zh-CN / en-US） */
function uiLocale(): string {
  const l = i18n.language ?? 'zh-CN';
  return l === 'zh' ? 'zh-CN' : l;
}

/** 生成时区下拉选项（本地化通用名 + 动态偏移，含 DST） */
export function timezoneOptions(): { value: string; label: string }[] {
  const d = new Date();
  const loc = uiLocale();
  return TIMEZONES.map((tz) => {
    let name = tz;
    try {
      name = new Intl.DateTimeFormat(loc, { timeZone: tz, timeZoneName: 'longGeneric' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? tz;
    } catch { /* 非法时区 fallback */ }
    let off = '';
    try {
      off = new Intl.DateTimeFormat(loc, { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
    } catch { /* 忽略 */ }
    // 中文界面用中文括号，英文界面用英文括号（CLDR 惯例：括号随语言）
    const isZh = loc.startsWith('zh');
    return { value: tz, label: off ? `${name}${isZh ? '（' : ' ('}${off}${isZh ? '）' : ')'}` : `${name}${isZh ? '（' : ' ('}${tz}${isZh ? '）' : ')'}` };
  });
}

/** 浏览器默认时区（若在 24 列表内则用，否则 Asia/Shanghai） */
export function browserTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (TIMEZONES.includes(tz)) return tz;
  } catch { /* 忽略 */ }
  return 'Asia/Shanghai';
}
