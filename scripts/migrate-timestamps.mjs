// 存量时间戳格式迁移（2026-08-06，幂等）：
// 统一为 PRD §5.3 标准 ISO `YYYY-MM-DDTHH:MM:SSZ`：
//   - 空格分隔 'YYYY-MM-DD HH:MM:SS[Z]' → 'T' 分隔
//   - 无 Z 后缀 → 补 Z（该格式曾被 JS 按浏览器本地时区解析，错 8 小时）
//   - 双 Z（users 表 schema 笔误 '...ZZ'）→ 单 Z
// 幂等：已是标准格式的行不受影响；可重复执行。
// 用法：node scripts/migrate-timestamps.mjs [SQLITE_PATH]
import Database from 'better-sqlite3';
import path from 'node:path';

const dbPath = process.argv[2] ?? path.resolve(import.meta.dirname, '..', 'data', 'policybot.db');
const db = new Database(dbPath);

// (表, 时间戳字段) 全量清单（含预留表；不存在的表/字段自动跳过）
const FIELDS = [
  ['users', ['created_at', 'updated_at']],
  ['policy_libraries', ['created_at', 'updated_at']],
  ['policy_lines', ['created_at', 'updated_at']],
  ['policy_versions', ['created_at', 'updated_at', 'published_at']],
  ['policy_chunks', ['created_at']],
  ['policy_images', ['created_at']],
  ['policy_references', ['created_at']],
  ['topic_routes', ['created_at', 'updated_at']],
  ['app_configs', ['updated_at']],
  ['policy_topics', ['created_at', 'updated_at']],
  ['intent_types', ['created_at', 'updated_at']],
  ['processes', ['created_at', 'updated_at']],
  ['conversations', ['created_at', 'updated_at']],
  ['messages', ['created_at']],
  ['feedbacks', ['created_at']],
];

let total = 0;
const changed = [];
for (const [table, cols] of FIELDS) {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  if (!exists) continue;
  for (const col of cols) {
    // 列存在性检查
    const colExists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!colExists) continue;
    const fixed = db.prepare(
      `UPDATE ${table} SET ${col} = CASE
         WHEN ${col} IS NULL THEN NULL
         WHEN ${col} LIKE '%ZZ' THEN REPLACE(${col}, 'ZZ', 'Z')
         WHEN ${col} LIKE '%Z' THEN REPLACE(${col}, ' ', 'T')
         ELSE REPLACE(${col}, ' ', 'T') || 'Z'
       END
       WHERE ${col} IS NOT NULL AND (${col} NOT GLOB '*T*:*:*Z' OR ${col} LIKE '%ZZ')`,
    ).run();
    if (fixed.changes > 0) { total += fixed.changes; changed.push(`${table}.${col} +${fixed.changes}`); }
  }
}
console.log(changed.length ? `[migrate-timestamps] 修正 ${total} 行：\n  ` + changed.join('\n  ') : '[migrate-timestamps] 无需修正（已是 ISO 格式）');
db.close();
