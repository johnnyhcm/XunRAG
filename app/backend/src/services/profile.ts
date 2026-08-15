// 个性化上下文构建（2026-08-11 动态化）——遍历启用字段（内置 + 预留 custom_1~10），注入"显示名：存储值"
// 值/名分离：字段名用 field_dicts.name（可改），值用 users 列存储值（稳定匹配）；multi 类型值 JSON 数组 → 顿号分隔
// 返回字段行文本（"- 地区：中国深圳"），外层文案由各模式模板（配置可改）包裹
import { getDb } from '../db/index.js';

// 安全白名单：仅允许 users 表已知列（防动态列名 SQL 注入）
const SAFE_COL = /^(region|gender|department|position|contract_type|level_type|other_tags|custom_[1-9]|custom_10)$/;

export function buildProfileLines(user: { id: string } | null | undefined): string {
  if (!user?.id) return '';
  try {
    const db = getDb();
    const fields = db.prepare('SELECT key, name, type FROM field_dicts WHERE enabled=1 AND in_context=1 ORDER BY sort').all() as { key: string; name: string; type: string }[];
    const cols = fields.map((f) => f.key).filter((k) => SAFE_COL.test(k));
    if (!cols.length) return '';
    const row = db.prepare(`SELECT ${cols.join(',')} FROM users WHERE id=?`).get(user.id) as Record<string, string | null> | undefined;
    if (!row) return '';
    const lines: string[] = [];
    for (const f of fields) {
      if (!SAFE_COL.test(f.key)) continue;
      const v = row[f.key];
      if (v === null || v === undefined || v === '') continue;
      const display = f.type === 'multi'
        ? (() => { try { const a = JSON.parse(v); return Array.isArray(a) ? a.join('、') : v; } catch { return v; } })()
        : v;
      lines.push(`- ${f.name}：${display}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}
