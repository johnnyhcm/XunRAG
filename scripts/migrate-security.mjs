#!/usr/bin/env node
// 密级体系迁移（2026-08-12，PRD §4.5.4 / TECH §3.6.x）——幂等，重复跑无副作用
// 1) field_dicts 加 security_level 字典（option，内置 is_system=1 不可删）
// 2) field_dict_options 加默认四档：公开/内部/机密/绝密
// 3) app_configs 加 security.policy（json 策略矩阵，每档 5 开关）
// 4) 存量政策 security_level=NULL → 打标"内部"（HR 政策合理默认）
// 用法：node scripts/migrate-security.mjs
import Database from 'better-sqlite3';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 2026-08-14：支持 SQLITE_PATH 指向测试/初始化库（与 migrate-reasoning 一致；init 脚本复用）
const db = new Database(process.env.SQLITE_PATH || path.join(root, 'data', 'policybot.db'));

// 1) security_level 字典
const dictExists = db.prepare("SELECT 1 FROM field_dicts WHERE key='security_level'").get();
if (!dictExists) {
  db.prepare(`INSERT INTO field_dicts (key, name, type, options, enabled, sort, created_at, updated_at, is_system, name_i18n, required, in_context)
    VALUES ('security_level', '密级', 'option', '["公开","内部","机密","绝密"]', 1, 5, strftime('%Y-%m-%dT%H:%M:%SZ','now'), NULL, 1, '{"zh":"密级","en":"Security Level"}', 0, 0)`).run();
  console.log('field_dicts.security_level 已建（内置，is_system=1）');
} else {
  console.log('field_dicts.security_level 已存在，跳过');
}

// 2) 默认四档选项
const LEVELS = [
  { value: '公开', label: '公开', en: 'Public', sort: 0 },
  { value: '内部', label: '内部', en: 'Internal', sort: 1 },
  { value: '机密', label: '机密', en: 'Confidential', sort: 2 },
  { value: '绝密', label: '绝密', en: 'Top Secret', sort: 3 },
];
let optN = 0;
for (const lv of LEVELS) {
  const exists = db.prepare("SELECT 1 FROM field_dict_options WHERE field_key='security_level' AND value=?").get(lv.value);
  if (!exists) {
    db.prepare(`INSERT INTO field_dict_options (id, field_key, value, label, label_en, enabled, sort, created_at, updated_at)
      VALUES (?, 'security_level', ?, ?, ?, 1, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), NULL)`).run(randomUUID(), lv.value, lv.label, lv.en, lv.sort);
    optN++;
  }
}
console.log(`security_level 选项：新增 ${optN} 个（共 ${LEVELS.length} 档）`);

// 3) 策略矩阵（app_configs.security.policy）
const policyDefault = JSON.stringify({
  公开: { watermark: false, copy_protect: false, ai_searchable: true, audit_read: false, audit_denied: false },
  内部: { watermark: false, copy_protect: true, ai_searchable: true, audit_read: false, audit_denied: true },
  机密: { watermark: true, copy_protect: true, ai_searchable: false, audit_read: true, audit_denied: true },
  绝密: { watermark: true, copy_protect: true, ai_searchable: false, audit_read: true, audit_denied: true },
}, null, 0);
const cfgExists = db.prepare("SELECT 1 FROM app_configs WHERE key='security.policy'").get();
if (!cfgExists) {
  db.prepare(`INSERT INTO app_configs (key, module, section, label, type, value, default_value, variables, options, description, sort)
    VALUES ('security.policy', 'common', 'security', '密级策略矩阵', 'json', ?, ?, NULL, NULL, '每档 5 开关：watermark/copy_protect/ai_searchable/audit_read/audit_denied', 83)`).run(null, policyDefault);
  console.log('app_configs.security.policy 已建');
} else {
  // 已有则补 default_value（幂等）
  db.prepare("UPDATE app_configs SET default_value=? WHERE key='security.policy' AND (default_value IS NULL OR default_value='')").run(policyDefault);
  console.log('app_configs.security.policy 已存在，default_value 已补');
}

// 4) 存量政策打标"内部"
const upd = db.prepare("UPDATE policy_lines SET security_level='内部' WHERE security_level IS NULL OR security_level=''").run();
console.log(`存量政策密级打标：${upd.changes} 条 → 内部`);

db.close();
console.log('\n密级体系迁移完成 ✅');
