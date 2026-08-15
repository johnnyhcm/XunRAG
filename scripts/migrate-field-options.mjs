#!/usr/bin/env node
// 用户属性重构迁移（2026-08-11，PRD §6.2.1）——幂等，重复跑无副作用
// 1) users 加 custom_1~custom_10（预留自定义字段槽位）
// 2) field_dicts 加 is_system / name_i18n 列
// 3) 建 field_dict_options 表（值/名分离：value 匹配用 / label 显示名）
// 4) 存量 field_dicts.options（JSON 数组）→ field_dict_options 行（value=label=原值；幂等：仅字段无选项行时）
// 5) 内置字段 is_system=1（region/contract_type/level_type/department/position）
// 6) gender 删除（2026-08-11 决策：field_dicts 行 + 其选项；users.gender 列保留不动）
import Database from 'better-sqlite3';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(path.join(root, 'data', 'policybot.db'));

const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
const hasTable = (t) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
const newId = (p = 'opt') => `${p}-${crypto.randomUUID().slice(0, 8)}`;

// 1) users.custom_1~10
for (let i = 1; i <= 10; i++) {
  if (!hasCol('users', `custom_${i}`)) {
    db.exec(`ALTER TABLE users ADD COLUMN custom_${i} TEXT`);
    console.log(`users.custom_${i} 已加`);
  }
}

// 2) field_dicts.is_system / name_i18n
if (!hasCol('field_dicts', 'is_system')) { db.exec(`ALTER TABLE field_dicts ADD COLUMN is_system INTEGER DEFAULT 0`); console.log('field_dicts.is_system 已加'); }
if (!hasCol('field_dicts', 'name_i18n')) { db.exec(`ALTER TABLE field_dicts ADD COLUMN name_i18n TEXT`); console.log('field_dicts.name_i18n 已加'); }

// 3) field_dict_options 表
if (!hasTable('field_dict_options')) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS field_dict_options (
      id          TEXT PRIMARY KEY,
      field_key   TEXT NOT NULL,
      value       TEXT NOT NULL,
      label       TEXT NOT NULL,
      label_en    TEXT,
      enabled     INTEGER DEFAULT 1,
      sort        INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at  TEXT,
      UNIQUE (field_key, value),
      FOREIGN KEY (field_key) REFERENCES field_dicts(key)
    );
    CREATE INDEX IF NOT EXISTS idx_field_options_key ON field_dict_options (field_key, enabled, sort);
  `);
  console.log('field_dict_options 表已建');
}

// 4) 存量 options → 选项行（幂等：仅字段无选项行时）
const fields = db.prepare("SELECT key, options FROM field_dicts WHERE options IS NOT NULL AND options != ''").all();
for (const f of fields) {
  const cnt = db.prepare('SELECT COUNT(*) c FROM field_dict_options WHERE field_key=?').get(f.key);
  if (cnt.c > 0) continue;
  let opts = [];
  try { const p = JSON.parse(f.options); if (Array.isArray(p)) opts = p.map(String).filter(Boolean); } catch { /* ignore */ }
  if (!opts.length) continue;
  const ins = db.prepare(`INSERT INTO field_dict_options (id, field_key, value, label, enabled, sort, created_at, updated_at) VALUES (?,?,?,?,1,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'),strftime('%Y-%m-%dT%H:%M:%SZ','now'))`);
  opts.forEach((v, i) => ins.run(newId(), f.key, v, v, i));
  console.log(`field_dicts.${f.key}：存量 ${opts.length} 个选项已迁移到 field_dict_options（value=label=原值）`);
}

// 5) 内置字段 is_system=1
const builtin = ['region', 'contract_type', 'level_type', 'department', 'position'];
for (const k of builtin) {
  db.prepare(`UPDATE field_dicts SET is_system=1 WHERE key=? AND is_system=0`).run(k);
}
console.log(`内置字段已标记 is_system=1：${builtin.join(', ')}`);

// 5.5) field_dicts.required（业务级必填可配置，2026-08-11）——存量内置核心字段默认必填（保持原有前端写死行为）
if (!hasCol('field_dicts', 'required')) {
  db.exec(`ALTER TABLE field_dicts ADD COLUMN required INTEGER DEFAULT 0`);
  console.log('field_dicts.required 已加');
}
for (const k of ['region', 'contract_type', 'level_type']) {
  db.prepare(`UPDATE field_dicts SET required=1 WHERE key=?`).run(k);
}
console.log('region/contract_type/level_type 默认 required=1（保持现状）');

// 5.7) field_dicts.in_context（注入对话上下文开关，2026-08-11）——内置核心字段默认开，预留字段默认关
if (!hasCol('field_dicts', 'in_context')) {
  db.exec(`ALTER TABLE field_dicts ADD COLUMN in_context INTEGER DEFAULT 0`);
  console.log('field_dicts.in_context 已加');
}
for (const k of ['region', 'contract_type', 'level_type', 'department', 'position']) {
  db.prepare(`UPDATE field_dicts SET in_context=1 WHERE key=?`).run(k);
}
console.log('内置核心字段 in_context=1（region/contract_type/level_type/department/position）');

// 6) gender 删除（2026-08-11 决策）
const gender = db.prepare(`SELECT 1 x FROM field_dicts WHERE key='gender'`).get();
if (gender) {
  db.prepare(`DELETE FROM field_dict_options WHERE field_key='gender'`).run();
  db.prepare(`DELETE FROM field_dicts WHERE key='gender'`).run();
  console.log('field_dicts.gender 已删除（users.gender 列保留不动）');
}

console.log('迁移完成');
db.close();
