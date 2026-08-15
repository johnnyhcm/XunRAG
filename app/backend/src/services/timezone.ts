// 多时区生效判定服务（2026-08-13，PRD §4.2.3 / TECH §3.6.x）
// 核心：生效 = 绝对时间点——effective_from 在政策线时区的 0 点转 UTC，nowUTC 比较，与用户/服务器时区无关
import { DateTime } from 'luxon';

export const DEFAULT_TZ = 'Asia/Shanghai';

/** 24 个常用 IANA 时区（显示标签由前端 Intl 生成，此处仅提供列表） */
export const TIMEZONES: string[] = [
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore',
  'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Kolkata', 'Asia/Dubai',
  'Europe/London', 'Europe/Berlin', 'Europe/Moscow', 'Europe/Istanbul',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'America/Mexico_City',
  'America/Sao_Paulo', 'Australia/Sydney', 'Pacific/Auckland', 'Africa/Johannesburg',
];

export const isValidTimezone = (tz: string | null | undefined): tz is string =>
  !!tz && TIMEZONES.includes(tz);

/**
 * 生效区间转 UTC 绝对时刻（政策时区 0 点）：
 *   start = effective_from 该时区 0 点转 UTC；end = effective_to 次日 0 点转 UTC（含 to 当天）
 *   例：from='2026-09-01', tz='America/Los_Angeles' → start=2026-09-01T07:00:00Z（夏季 DST -7）
 */
export function effectiveRangeUTC(from: string | null, to: string | null, tz: string | null):
  { start: Date | null; end: Date | null } {
  const zone = isValidTimezone(tz) ? tz : DEFAULT_TZ;
  const start = from ? DateTime.fromISO(from, { zone }).startOf('day').toUTC().toJSDate() : null;
  const end = to ? DateTime.fromISO(to, { zone }).startOf('day').plus({ days: 1 }).toUTC().toJSDate() : null;
  return { start, end };
}

/** 该政策版本此刻是否生效（绝对时刻判定，now 默认当前） */
export function isVersionEffective(from: string | null, to: string | null, tz: string | null, now: Date = new Date()): boolean {
  const { start, end } = effectiveRangeUTC(from, to, tz);
  if (start && now < start) return false;
  if (end && now >= end) return false;
  return true;
}

/** 版本状态（管理端/浏览端展示）：active 生效中 / pending 待生效 / expired 已失效 */
export function versionStatus(from: string | null, to: string | null, tz: string | null, now: Date = new Date()): 'active' | 'pending' | 'expired' {
  const { start, end } = effectiveRangeUTC(from, to, tz);
  if (start && now < start) return 'pending';
  if (end && now >= end) return 'expired';
  return 'active';
}

/** 某时区此刻的日期（YYYY-MM-DD，管理端"今天"展示用） */
export function todayInTz(tz: string | null): string {
  const zone = isValidTimezone(tz) ? tz : DEFAULT_TZ;
  return DateTime.now().setZone(zone).toFormat('yyyy-MM-dd');
}
