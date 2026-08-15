#!/usr/bin/env node
// 安全配置入口收敛迁移（2026-08-13，DISSCUSION 决策 / PRD §4.5.4）——幂等，重复跑无副作用
// 背景：5 个安全配置（水印/禁复制/强制改密/密级档位/策略矩阵）module='common' → 在问答配置页「通用-安全」
//       Card 重复显示（与安全设置页双入口，json 裸编辑互相覆盖风险）；首次登录强制改密仅问答配置有入口。
// 收敛：module 统一改 'security' → ConfigParamsPage 只渲染 efficient/smart/common 三 Tab，自动隐藏；
//       安全设置页为唯一入口（force_change 开关由 SecurityPage 补齐）。
// 读链不受影响（getConfig/PUT /api/configs 均按 key 定位，module 仅为分组字段）。
// 用法：node scripts/migrate-security-entry.mjs（支持 SQLITE_PATH 指向测试库）
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(process.env.SQLITE_PATH || path.join(root, 'data', 'policybot.db'));

const KEYS = [
  'common.security.watermark_enabled',
  'common.security.copy_protect_enabled',
  'common.security.force_change_on_first_login',
  'security.levels',
  'security.policy',
];
const r = db.prepare(`UPDATE app_configs SET module='security' WHERE module='common' AND key IN (${KEYS.map(() => '?').join(',')})`).run(...KEYS);
console.log(`安全配置 module 收敛 common→security：更新 ${r.changes} 行（幂等：重复跑为 0）`);

// 校验
const rows = db.prepare(`SELECT key, module, section FROM app_configs WHERE key IN (${KEYS.map(() => '?').join(',')}) ORDER BY key`).all(...KEYS);
rows.forEach((row) => console.log(`  ${row.key}: module=${row.module} section=${row.section}`));
const remain = db.prepare(`SELECT COUNT(*) c FROM app_configs WHERE module='common' AND key LIKE '%.security%'`).get().c;
console.log(`common 模块残留 security 前缀 key：${remain}（应为 0）`);
db.close();
