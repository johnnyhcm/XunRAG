#!/usr/bin/env node
// 配置项双语维护迁移（2026-08-14，DISSCUSION 决策 / PRD §4.4.9）——幂等，重复跑无副作用
// 1) app_configs 加 i18n 列（1=用户可见文案类，配置页显示英文值编辑区）
// 2) 标记 19 个文案 key（剔除误判的 efficient.generate.low_confidence_words——LLM 信号词非文案）
// 3) 补漏种子：产品名/slogan/问候×3 的 value_en（当前英文界面显示中文）
// 4) 对齐：common.home.suggestions 的 value_en 重写为当前中文 4 条的翻译（旧种子 6 条已漂移）
// 用法：node scripts/migrate-config-bilingual.mjs（支持 SQLITE_PATH 指向测试库）
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(process.env.SQLITE_PATH || path.join(root, 'data', 'policybot.db'));

// ---------- 1) i18n 列（幂等） ----------
const cols = db.prepare('PRAGMA table_info(app_configs)').all().map((c) => c.name);
if (!cols.includes('i18n')) {
  db.exec('ALTER TABLE app_configs ADD COLUMN i18n INTEGER DEFAULT 0');
  console.log('[1] app_configs.i18n 列已添加');
} else {
  console.log('[1] app_configs.i18n 列已存在');
}

// ---------- 2) 标记 19 个文案 key ----------
const I18N_KEYS = [
  // 前端显示型（首页/反馈）
  'common.home.suggestions', 'common.home.title', 'common.home.subtitle',
  'common.home.greeting_morning', 'common.home.greeting_afternoon', 'common.home.greeting_evening',
  'common.ui.stage_recognize', 'common.ui.stage_retrieve', 'common.ui.stage_generate', 'common.ui.stage_thinking', 'common.ui.stage_default',
  'common.feedback.reasons',
  // 后端回答文案型（getConfigLocalized 消费）
  'efficient.reply.reject_text', 'efficient.reply.clarify_text', 'efficient.reply.contact_text',
  'efficient.reply.topic_guide_text', 'efficient.reply.reject_hint_text',
  'efficient.reply.action_process_text', 'efficient.reply.action_query_text',
];
const mark = db.prepare(`UPDATE app_configs SET i18n=1 WHERE key=? AND i18n<>1`);
let marked = 0;
for (const k of I18N_KEYS) marked += mark.run(k).changes;
console.log(`[2] 标记 i18n=1：${marked} 项（共 ${I18N_KEYS.length} 个文案 key）`);

// ---------- 3) 补漏种子（value_en IS NULL 才填，不覆盖管理员已配） ----------
const seedEn = db.prepare(`UPDATE app_configs SET value_en=? WHERE key=? AND (value_en IS NULL OR value_en='')`);
const SEED = [
  ['common.home.title', 'Enterprise Policy AI'],
  ['common.home.subtitle', 'Your AI policy assistant'],
  ['common.home.greeting_morning', 'Good morning'],
  ['common.home.greeting_afternoon', 'Good afternoon'],
  ['common.home.greeting_evening', 'Good evening'],
];
let seeded = 0;
for (const [k, en] of SEED) seeded += seedEn.run(en, k).changes;
console.log(`[3] 补漏 value_en 种子：${seeded} 项（title/subtitle/问候×3）`);

// ---------- 4) 对齐建议问题（value_en = 当前中文 value 的 4 条翻译） ----------
const sug = db.prepare(`SELECT value FROM app_configs WHERE key='common.home.suggestions'`).get();
const sugZh = sug?.value ? (() => { try { const a = JSON.parse(sug.value); return Array.isArray(a) ? a : null; } catch { return null; } })() : null;
const SUG_EN = JSON.stringify([
  'What leave do I have?',
  'What is the accommodation standard for business travel?',
  'How do I file an expense reimbursement?',
  'What allowances do expatriate employees get?',
]);
if (sugZh) {
  db.prepare(`UPDATE app_configs SET value_en=? WHERE key='common.home.suggestions'`).run(SUG_EN);
  console.log(`[4] 建议问题 value_en 对齐：${sugZh.length} 条 → 英文 ${JSON.parse(SUG_EN).length} 条（一一对应翻译）`);
} else {
  console.log('[4] 建议问题 value 为空/非数组，跳过对齐（不覆盖）');
}

// 校验
const rows = db.prepare("SELECT key, i18n, value_en FROM app_configs WHERE i18n=1 ORDER BY key").all();
console.log(`\ni18n 标记清单（${rows.length} 项）：`);
rows.forEach((r) => console.log(`  ${r.i18n === 1 ? '✅' : '❌'} ${r.key}${r.value_en ? '' : ' ⚠️无英文'}`));
const lowConf = db.prepare("SELECT i18n FROM app_configs WHERE key='efficient.generate.low_confidence_words'").get();
console.log(`low_confidence_words i18n=${lowConf?.i18n}（应为 0：LLM 信号词非文案）`);
db.close();
