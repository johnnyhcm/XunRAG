#!/usr/bin/env node
// 模型推理开关迁移（2026-08-13，PRD §4.4.9 / DISSCUSION 2026-08-13 决策）——幂等，重复跑无副作用
// 1) app_configs 加两行：efficient.reasoning（高效模式推理开关，默认关 0）/ smart.reasoning（智能模式推理开关，默认开 1）
// 2) 存量迁移：llm_config.thinking（本地引擎思考，界面已移除）→ smart.reasoning 显式写值（1→1、0→0），保证行为不变
// 用法：node scripts/migrate-reasoning.mjs
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 2026-08-13：支持 SQLITE_PATH 指向测试库（测试环境隔离规范，AGENTS.md）
const db = new Database(process.env.SQLITE_PATH || path.join(root, 'data', 'policybot.db'));

// 1) 配置行（幂等：INSERT OR IGNORE）
const insert = db.prepare(`INSERT OR IGNORE INTO app_configs
  (key, module, section, label, label_en, type, value, default_value, description, description_en, sort, updated_at, updated_by)
  VALUES (?, ?, ?, ?, ?, 'bool', ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), NULL)`);
insert.run(
  'efficient.reasoning', 'efficient', 'generate', '模型推理', 'Model reasoning',
  '0', '0', '高效模式回答生成时是否启用模型推理能力（默认关，快而稳；开启后回答更深但更慢更贵）。意图识别等内部步骤不受影响。',
  'Whether efficient mode uses model reasoning when generating answers (off by default: fast & stable; on: deeper but slower & costlier). Internal steps like intent recognition are unaffected.',
  20,
);
insert.run(
  'smart.reasoning', 'smart', 'thinking', '模型推理', 'Model reasoning',
  '1', '1', '智能模式回答生成时是否启用模型推理能力（默认开，深而全；关闭后可降低成本与延迟）。',
  'Whether smart mode uses model reasoning when generating answers (on by default: deep & thorough; off to reduce cost and latency).',
  10,
);
// 存量修正：早期版本 section 用了中文（「组织」「思考」），统一为英文 key（前端 config.section.* 本地化依赖英文 key）
db.prepare("UPDATE app_configs SET section='generate' WHERE key='efficient.reasoning' AND section<>'generate'").run();
db.prepare("UPDATE app_configs SET section='thinking' WHERE key='smart.reasoning' AND section<>'thinking'").run();
console.log('app_configs：efficient.reasoning / smart.reasoning 配置行已就位（INSERT OR IGNORE + section 统一英文 key）');

// 2) 存量迁移：llm_config.thinking → smart.reasoning 显式值（行为不变；仅当 llm_config 有行时才迁移——新库/无界面配置不覆盖默认）
const hasThinking = db.prepare("PRAGMA table_info(llm_config)").all().some((c) => c.name === 'thinking');
if (hasThinking) {
  const row = db.prepare('SELECT thinking FROM llm_config WHERE id=1').get();
  if (row) {
    const thinking = Number(row.thinking ?? 0);
    db.prepare(`UPDATE app_configs SET value=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE key='smart.reasoning'`)
      .run(thinking ? '1' : '0');
    console.log(`存量迁移：llm_config.thinking=${thinking} → smart.reasoning=${thinking ? 1 : 0}（行为不变）`);
  } else {
    console.log('llm_config 无行（未配置过界面模型），跳过存量迁移（smart.reasoning 保持默认 1）');
  }
} else {
  console.log('llm_config 无 thinking 列，跳过存量迁移（smart.reasoning 保持默认 1）');
}

// 校验
const rows = db.prepare("SELECT key, module, section, type, value, default_value FROM app_configs WHERE key IN ('efficient.reasoning','smart.reasoning')").all();
console.log('校验：', JSON.stringify(rows, null, 1));
db.close();
