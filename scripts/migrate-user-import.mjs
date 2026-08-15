// 用户导入字段元数据迁移（2026-08-07，PRD §4.1.5 CSV 闭环设计）
// 用法：node scripts/migrate-user-import.mjs [db路径]
// 幂等：可重复执行（schema 由 CREATE TABLE IF NOT EXISTS 保证；种子 INSERT OR IGNORE）
// 作用：user_import_fields 表驱动 CSV 模板/导出/导入——未来 users 表新增定制字段仅需加元数据行
import fs from 'node:fs';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.argv[2] || path.resolve(__dirname, '..', 'data', 'policybot.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// schema（含新表 user_import_fields，CREATE IF NOT EXISTS 幂等）
const schemaSql = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'backend', 'src', 'db', 'schema.sql'), 'utf8');
db.exec(schemaSql);
console.log('[0] schema 已就绪（user_import_fields）');

// 种子：基础 10 列（顺序 = CSV 列顺序）
const ins = db.prepare(`INSERT OR IGNORE INTO user_import_fields (field, label, type, required, unique_key, dict_key, importable, sort)
  VALUES (?,?,?,?,?,?,1,?)`);
const fields = [
  ['id', '用户ID', 'text', 0, 0, null, 0],            // 导入键：留空=新增，有值=更新（UUID 定位）
  ['employee_no', '工号', 'text', 1, 1, null, 1],
  ['name', '姓名', 'text', 1, 0, null, 2],
  ['email', '邮箱', 'text', 0, 1, null, 3],            // 唯一暂保持现状（2026-08-07 决策）
  ['department', '部门', 'option', 0, 0, 'department', 4],
  ['region', '地区', 'option', 0, 0, 'region', 5],
  ['contract_type', '合同类型', 'option', 0, 0, 'contract_type', 6],
  ['level_type', '层级类型', 'option', 0, 0, 'level_type', 7],
  ['position', '岗位', 'option', 0, 0, 'position', 8],
  ['status', '状态', 'text', 0, 0, null, 9],           // 枚举 active/inactive：空=不改（新用户默认启用）；inactive=停用；active=启用
];
let n = 0;
for (const f of fields) { ins.run(...f); n++; }
console.log(`[1] user_import_fields 种子 ${n} 项（已存在跳过）`);

db.close();
console.log('用户导入字段元数据迁移完成 ✅');
