#!/usr/bin/env node
// 适用范围规则迁移（2026-08-12，PRD §4.4.2 / TECH §3.6.x）——幂等，重复跑无副作用
// 1) 加列：policy_libraries.apply_rules、policy_lines.apply_rules（库级/文件级适用范围规则，NULL=继承/全员）
// 2) 删列：policy_lines.apply_region / apply_audience（2026-08-12 废弃，改规则机制；SQLite 3.35+ DROP COLUMN）
// 用法：node scripts/migrate-applicability.mjs
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(path.join(root, 'data', 'policybot.db'));

const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

// 1) 加 apply_rules 列
for (const [table, comment] of [['policy_libraries', '库级适用范围规则（NULL=全员适用）'], ['policy_lines', '文件级适用范围规则（NULL=继承库）']]) {
  if (!hasCol(table, 'apply_rules')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN apply_rules TEXT`);
    console.log(`${table}.apply_rules 已加（${comment}）`);
  } else {
    console.log(`${table}.apply_rules 已存在，跳过`);
  }
}

// 2) 删旧列（apply_region / apply_audience 废弃）
for (const col of ['apply_region', 'apply_audience']) {
  if (hasCol('policy_lines', col)) {
    db.exec(`ALTER TABLE policy_lines DROP COLUMN ${col}`);
    console.log(`policy_lines.${col} 已删（废弃）`);
  } else {
    console.log(`policy_lines.${col} 不存在，跳过`);
  }
}

console.log('适用范围规则迁移完成');
