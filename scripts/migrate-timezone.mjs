#!/usr/bin/env node
// 多时区迁移（2026-08-13，PRD §4.2.3 / TECH §3.6.x）——幂等
// 1) policy_libraries 加 timezone（库级默认时区）：Fin-US 类=America/Los_Angeles，其他=Asia/Shanghai
// 2) policy_lines 加 timezone（政策线级，继承库，发布时确认；版本继承 line）
// 3) 存量回填：库/线 timezone NULL → 默认
// 用法：node scripts/migrate-timezone.mjs
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(path.join(root, 'data', 'policybot.db'));
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);

// 1) 库级时区
if (!hasCol('policy_libraries', 'timezone')) {
  db.exec(`ALTER TABLE policy_libraries ADD COLUMN timezone TEXT`);
  console.log('policy_libraries.timezone 已加');
}
// Fin-US 库 → LA；其他库 → Asia/Shanghai（按库名/性质判断；Fin-US 是唯一美国库）
const libRows = db.prepare('SELECT id, name, timezone FROM policy_libraries').all();
let libN = 0;
for (const l of libRows) {
  const tz = /Fin|US|America/i.test(l.name) ? 'America/Los_Angeles' : 'Asia/Shanghai';
  if (!l.timezone) { db.prepare('UPDATE policy_libraries SET timezone=? WHERE id=?').run(tz, l.id); libN++; }
}
console.log(`policy_libraries 时区回填 ${libN} 条（Fin-US→LA，其他→Shanghai）`);

// 2) 线级时区（继承库）
if (!hasCol('policy_lines', 'timezone')) {
  db.exec(`ALTER TABLE policy_lines ADD COLUMN timezone TEXT`);
  console.log('policy_lines.timezone 已加');
}
const lineRows = db.prepare('SELECT l.id, lib.timezone FROM policy_lines l JOIN policy_libraries lib ON lib.id=l.library_id WHERE l.timezone IS NULL').all();
let lineN = 0;
for (const l of lineRows) {
  db.prepare('UPDATE policy_lines SET timezone=? WHERE id=?').run(l.timezone ?? 'Asia/Shanghai', l.id);
  lineN++;
}
console.log(`policy_lines 时区回填 ${lineN} 条（继承库）`);

// 3) 校验
console.log('\n库时区:', db.prepare('SELECT name, timezone FROM policy_libraries').all());
console.log('线时区样例:', db.prepare("SELECT name, timezone FROM policy_lines WHERE timezone='America/Los_Angeles' LIMIT 5").all());
console.log('\n多时区迁移完成');
