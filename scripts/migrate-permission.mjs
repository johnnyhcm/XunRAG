#!/usr/bin/env node
// 权限模型迁移（2026-08-07，PRD §3.3 / TECH §3.6.x）——幂等，重复跑无副作用
// 1) 建表：user_groups / user_group_rules / user_group_members / field_dicts
// 2) 加列：policy_libraries.visible_rules/admin_group_ids、policy_lines.visible_rules、
//          user_groups.function_ids/managed_library_ids、user_group_rules.operator、
//          user_group_members.type、messages.user_id（2026-08-07 补齐，新库由 schema.sql 直接建全）
// 3) 种子：内置组（system_admin/employee，含方案 B 功能/管理范围）+ 字段字典（region/contract_type/level_type/department/position）
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(path.join(root, 'data', 'policybot.db'));

const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
const hasTable = (t) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);

// 1) 建表（与 schema.sql 保持一致）
if (!hasTable('user_groups')) {
  db.exec(`CREATE TABLE user_groups (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'manual',
    description TEXT, enabled INTEGER DEFAULT 1, sort INTEGER DEFAULT 0,
    function_ids TEXT, managed_library_ids TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT)`);
  console.log('user_groups 已建');
}
if (!hasTable('user_group_rules')) {
  db.exec(`CREATE TABLE user_group_rules (
    id TEXT PRIMARY KEY, group_id TEXT NOT NULL, rule_no INTEGER DEFAULT 0,
    field TEXT NOT NULL, operator TEXT DEFAULT 'in', allowed_values TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_group_rules_group ON user_group_rules (group_id)');
  console.log('user_group_rules 已建');
}
if (!hasTable('user_group_members')) {
  db.exec(`CREATE TABLE user_group_members (
    group_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT DEFAULT 'include',
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY (group_id, user_id))`);
  console.log('user_group_members 已建');
}
if (!hasTable('field_dicts')) {
  db.exec(`CREATE TABLE field_dicts (
    key TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'option',
    options TEXT, enabled INTEGER DEFAULT 1, sort INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT)`);
  console.log('field_dicts 已建');
}

// 2) 加列
if (!hasCol('policy_libraries', 'admin_group_ids')) {
  db.exec(`ALTER TABLE policy_libraries ADD COLUMN admin_group_ids TEXT`); // JSON 数组（管理组 id）
  console.log('policy_libraries.admin_group_ids 已加');
}
if (!hasCol('policy_libraries', 'visible_rules')) {
  db.exec(`ALTER TABLE policy_libraries ADD COLUMN visible_rules TEXT`); // JSON 可见条件（库级默认）
  console.log('policy_libraries.visible_rules 已加');
}
if (!hasCol('policy_lines', 'visible_rules')) {
  db.exec(`ALTER TABLE policy_lines ADD COLUMN visible_rules TEXT`); // JSON 可见条件（NULL=继承库）
  console.log('policy_lines.visible_rules 已加');
}
// 2026-08-07 补齐：方案 B 列 + 历史隔离列（存量库升级用；新库 schema.sql 已直接建全）
for (const [table, col, ddl] of [
  ['user_groups', 'function_ids', 'TEXT'],
  ['user_groups', 'managed_library_ids', 'TEXT'],
  ['user_group_rules', 'operator', "TEXT DEFAULT 'in'"],
  ['user_group_members', 'type', "TEXT DEFAULT 'include'"],
  ['messages', 'user_id', 'TEXT'],
]) {
  if (!hasCol(table, col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    console.log(`${table}.${col} 已加`);
  }
}

// 3) 内置组种子（方案 B：system_admin=全功能+ALL；employee=query；含管理范围列）
const now = () => new Date().toISOString();
const insGroup = db.prepare(`INSERT OR IGNORE INTO user_groups (id, name, type, description, enabled, sort, function_ids, managed_library_ids, created_at) VALUES (?,?,?,?,1,?,?,?,?)`);
insGroup.run('system_admin', '系统管理员组', 'builtin', '全功能全数据，仅手动加入（安全红线）', 0, JSON.stringify(['policy_mgmt', 'user_mgmt', 'role_mgmt', 'config_mgmt', 'stats_view']), JSON.stringify(['ALL']), now());
insGroup.run('employee', '员工组', 'builtin', '全员默认：查询原文 + 智能检索', 1, JSON.stringify(['query']), null, now());
console.log('内置组已种子：system_admin / employee（含方案 B 功能/管理范围）');

// 4) 字段字典种子（选项字段，动态组/可见性判定依据）
const insField = db.prepare(`INSERT OR IGNORE INTO field_dicts (key, name, type, options, enabled, sort, created_at) VALUES (?,?,?,?,1,?,?)`);
const fields = [
  ['region', '地区', JSON.stringify(['中国北京', '中国深圳', '美国加州']), 0],
  ['contract_type', '合同类型', JSON.stringify(['正式', '实习', '外包']), 1],
  ['level_type', '层级', JSON.stringify(['高管', '管理者', 'IC']), 2],
  ['department', '部门', JSON.stringify(['人力资源部', '技术部', '销售部', '制造部', '财务部', '行政部', '市场部']), 3],
  ['position', '岗位', JSON.stringify(['经理', '主管', '专员', '工程师', '分析师', '销售代表', 'HR专员', '财务专员']), 4],
];
for (const [k, n, opts, sort] of fields) insField.run(k, n, 'option', opts, sort, now());
console.log(`字段字典已种子：${fields.length} 个`);

db.close();
console.log('权限模型迁移完成（幂等）');
