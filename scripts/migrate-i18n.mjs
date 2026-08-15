// 系统 i18n 迁移（2026-08-13，PRD §5.3 / DISSCUSION 2026-08-13）
// 1) users 加 language（BCP47，默认 zh-CN；用户档案语言权威）
// 2) app_configs 加 value_en（用户可见文案类 key 的英文值；locale=en → value_en ?? value）
// 3) 为用户可见文案类 key 种子英文默认值（LLM 提示词/调优参数不翻译）
// 幂等：ALTER TABLE 判断列存在；value_en 用 UPDATE ... WHERE value_en IS NULL 补种子
// 用法：node scripts/migrate-i18n.mjs [db路径]
import { readFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';

const dbPath = process.argv[2] ?? 'data/policybot.db';
if (!existsSync(dbPath)) { console.error(`DB not found: ${dbPath}`); process.exit(1); }
const db = new Database(dbPath);

// ---------- 1. users.language ----------
const userCols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
if (!userCols.includes('language')) {
  db.exec(`ALTER TABLE users ADD COLUMN language TEXT DEFAULT 'zh-CN'`);
  console.log('[1] users.language 已添加（默认 zh-CN）');
} else {
  console.log('[1] users.language 已存在，跳过');
}

// ---------- 2. app_configs.value_en ----------
const cfgCols = db.prepare(`PRAGMA table_info(app_configs)`).all().map((c) => c.name);
if (!cfgCols.includes('value_en')) {
  db.exec(`ALTER TABLE app_configs ADD COLUMN value_en TEXT`);
  console.log('[2] app_configs.value_en 已添加');
} else {
  console.log('[2] app_configs.value_en 已存在，跳过');
}

// ---------- 2b. app_configs.label_en / description_en（配置项展示名/说明本地化）----------
if (!cfgCols.includes('label_en')) {
  db.exec(`ALTER TABLE app_configs ADD COLUMN label_en TEXT`);
  db.exec(`ALTER TABLE app_configs ADD COLUMN description_en TEXT`);
  console.log('[2b] app_configs.label_en/description_en 已添加');
} else {
  console.log('[2b] app_configs.label_en/description_en 已存在，跳过');
}

// ---------- 3. 用户可见文案类 key 英文种子（不覆盖管理员已填的 value_en） ----------
// 注：LLM 提示词（efficient.generate.prompt / efficient.intent.prompt / smart.*）与调优参数不翻译
const EN_SEED = {
  'common.feedback.reasons': '["Answer inaccurate","Not found","Hard to understand","Citation error","Other"]',
  'common.home.suggestions': '["How many annual leave days?","How many maternity leave days does the Guangdong branch offer?","What is the accommodation standard for business travel?","What allowances do expatriate employees get?","How is the intern allowance calculated?","How do I apply for a travel advance?"]',
  'common.ui.stage_default': '⏳ Processing…',
  'common.ui.stage_generate': '💭 Organizing the answer…',
  'common.ui.stage_recognize': '🔍 Understanding your question…',
  'common.ui.stage_retrieve': '📚 Searching relevant policies…',
  'common.ui.stage_thinking': '🤔 AI is thinking…',
  'efficient.generate.low_confidence_words': 'No relevant content found|not found|cannot determine|uncertain|please consult',
  'efficient.reply.action_process_text': 'Go to process',
  'efficient.reply.action_query_text': 'Do you want to apply?',
  'efficient.reply.clarify_text': 'To give you a more accurate answer, please provide: ',
  'efficient.reply.contact_text': 'Your question needs human assistance. We are connecting you with: ',
  'efficient.reply.reject_hint_text': 'If you need human assistance, please reply "transfer to human".',
  'efficient.reply.reject_text': 'No relevant content found in the policy library.',
  'efficient.reply.topic_guide_text': 'To find the right contact, please specify the business topic you are asking about (e.g., business travel, attendance, expatriation, reimbursement).',
};
let updated = 0;
for (const [key, en] of Object.entries(EN_SEED)) {
  const r = db.prepare(`UPDATE app_configs SET value_en = ? WHERE key = ? AND value_en IS NULL`).run(en, key);
  updated += r.changes;
}
console.log(`[3] value_en 英文种子更新 ${updated} 条（共 ${Object.keys(EN_SEED).length} 个文案 key）`);

// ---------- 3b. 配置项 label/description 英文种子（label_en/description_en，不覆盖管理员已填）----------
// [label_en, description_en]；description 为 null 的 key 只填 label_en
const LABEL_SEED = {
  'common.home.suggestions': ['Home suggestions', null],
  'common.home.title': ['Product name (top bar + home title)', 'Shown in the top-left link and home welcome title; unified brand name across the site'],
  'common.home.subtitle': ['Home subtitle (slogan)', 'Welcome-area slogan; replaceable with your company tagline'],
  'common.home.greeting_enabled': ['Show time-based greeting', 'Shows "Good morning, {name}" etc. in the welcome area; off = hidden'],
  'common.home.greeting_morning': ['Greeting - morning (5-11)', 'Concatenated with the user name as "greeting, name"'],
  'common.home.greeting_afternoon': ['Greeting - afternoon (12-17)', null],
  'common.home.greeting_evening': ['Greeting - evening (18-4)', null],
  'common.ui.stage_recognize': ['Stage text - understanding question', null],
  'common.ui.stage_retrieve': ['Stage text - searching policies', null],
  'common.ui.stage_generate': ['Stage text - organizing answer', null],
  'common.ui.stage_thinking': ['Stage text - AI thinking', null],
  'common.ui.stage_default': ['Stage text - default', null],
  'common.feedback.reasons': ['Feedback reason options', null],
  'common.session.expire_hours': ['Session expiry (hours)', null],
  'common.security.watermark_enabled': ['Read page watermark (anti-screenshot tracing)', 'Tiles user name + employee no. + access time on the policy page; traceable in screenshots/prints; off = no watermark'],
  'common.security.copy_protect_enabled': ['Read page copy protection', 'Disables selecting/copying policy text (Ctrl+C, right-click, drag-select); off = copying allowed'],
  'common.security.force_change_on_first_login': ['Force password change on first login', 'When user must_change_password=1 (new/import/reset/migration), forces a non-closable password change dialog after login; defaults to off'],
  'security.levels': ['Security levels', 'Security level list (maintained in Security Settings)'],
  'security.policy': ['Security level policy matrix', 'Five switches per level: watermark/copy_protect/ai_searchable/audit_read/audit_denied'],
  'efficient.intent.prompt': ['Intent recognition prompt', 'Intent recognition system prompt; {topics}/{intent_types}/{processes} are injected from data dictionaries — keep placeholders'],
  'efficient.intent.max_intents': ['Max intents', 'Maximum number of intents to split one question into'],
  'efficient.intent.timeout_ms': ['Intent recognition timeout (ms)', null],
  'efficient.retrieve.hybrid': ['Hybrid retrieval (BM25 + vector)', 'Off = vector only'],
  'efficient.retrieve.rerank': ['Rerank', 'Off = skip reranking'],
  'efficient.retrieve.top_k': ['Top-K (into generation context)', null],
  'efficient.retrieve.fused_candidates': ['Fused candidates (before rerank)', null],
  'efficient.retrieve.rrf_k': ['RRF fusion k', null],
  'efficient.retrieve.bm25_k1': ['BM25 k1', null],
  'efficient.retrieve.bm25_b': ['BM25 b', null],
  'efficient.retrieve.applicable_boost': ['Applicability boost α (soft ranking)', 'Hit applicability rules → final score ×(1+α)'],
  'efficient.retrieve.inapplicable_penalty': ['Not-applicable penalty β (soft ranking)', 'Clearly not applicable (attribute set and no match) → ×(1-β)'],
  'efficient.retrieve.timeout_ms': ['Retrieval timeout (ms)', 'Timeout for calling Python /search'],
  'efficient.request.timeout_ms': ['Request timeout (ms)', 'Overall per-round Q&A timeout'],
  'efficient.generate.prompt': ['Generation system prompt', '{reject_text}/{profile_section} are injected by the system'],
  'efficient.branch.timeout_ms': ['Branch retrieval timeout (ms)', 'Per-intent branch timeout; timed-out branch degrades to empty results'],
  'efficient.generate.low_confidence_words': ['Low-confidence signal words (| separated)', 'Answer containing these words is judged low-confidence (human handoff)'],
  'efficient.generate.max_rounds': ['Max conversation rounds', 'Coexists with 24h expiry; whichever triggers first'],
  'efficient.generate.timeout_ms': ['Generation timeout (ms)', 'Timeout for DeepSeek streaming generation'],
  'efficient.reply.reject_text': ['Rejection text', null],
  'efficient.reply.clarify_text': ['Clarification text', null],
  'efficient.reply.reject_hint_text': ['Rejection human-handoff hint', 'Efficient mode: appended after rejection for policy-related questions (not for unrelated questions)'],
  'efficient.reply.contact_text': ['Human handoff text', null],
  'efficient.reply.topic_guide_text': ['Topic guide text', null],
  'efficient.reply.action_process_text': ['Action suggestion text (process entry)', null],
  'efficient.reply.action_query_text': ['Action suggestion text (post-query weak hint)', null],
  'efficient.reply.l2_threshold': ['L2 contact threshold', 'Trigger human handoff when Top-N mean score is below this'],
  'efficient.mode.enabled': ['Efficient mode switch', 'Off: efficient mode hidden/disabled in chat; in-progress/history efficient sessions cannot continue; vectorization unaffected'],
  'smart.prompt.system': ['Agent role (system prompt)', 'Overrides Pi SDK default agent role; affects answer style and behavior boundaries'],
  'smart.prompt.clarify': ['Vague-question clarification prompt', null],
  'smart.prompt.process_dict': ['Process dictionary injection prompt', null],
  'smart.retrieve.unit': ['Retrieval unit', 'Data unit for smart mode retrieval'],
  'smart.tool.policy_grep_desc': ['policy_grep tool description', null],
  'smart.retrieve.grep_top_n': ['Lexical max returns per call', 'Max hits policy_grep returns per call'],
  'smart.prompt.profile': ['Personalization prompt', null],
  'smart.prompt.risk': ['Risk warning prompt', null],
  'smart.prompt.contact_dict': ['Human-handoff contact rules', 'Smart mode: injects contact dictionary and handoff rules (variable {contacts})'],
};
let labelUpdated = 0;
for (const [key, [labelEn, descEn]] of Object.entries(LABEL_SEED)) {
  const r = db.prepare(`UPDATE app_configs SET label_en = COALESCE(label_en, ?), description_en = COALESCE(description_en, ?) WHERE key = ?`).run(labelEn, descEn ?? null, key);
  labelUpdated += r.changes;
}
console.log(`[3b] 配置项 label/description 英文种子更新 ${labelUpdated} 条（共 ${Object.keys(LABEL_SEED).length} 个配置项）`);

// ---------- 4. 选项字段 i18n 数据补全 ----------
// 4a. 内置字段 name_i18n.en（只补缺失；保留用户自定义）
const FIELD_NAME_EN = {
  contract_type: 'Contract type', level_type: 'Level', department: 'Department', position: 'Position',
  custom_1: "Youngest child's birthday",
};
let fld = 0;
for (const [k, en] of Object.entries(FIELD_NAME_EN)) {
  const r = db.prepare(`UPDATE field_dicts SET name_i18n = json_set(COALESCE(name_i18n, '{}'), '$.en', ?) WHERE key=? AND (name_i18n IS NULL OR json_extract(name_i18n, '$.en') IS NULL OR json_extract(name_i18n, '$.en')='')`).run(en, k);
  fld += r.changes;
}
console.log(`[4a] 字段英文名补全 ${fld} 个`);
// 4b. 选项 label_en（只补缺失）
const OPTION_LABEL_EN = {
  'region|中国北京': 'Beijing', 'region|美国加州': 'California (US)',
  'contract_type|正式': 'Regular', 'contract_type|实习': 'Intern', 'contract_type|外包': 'Outsourced',
  'level_type|高管': 'Executive', 'level_type|管理者': 'Manager', 'level_type|IC': 'IC',
  'department|人力资源部': 'HR', 'department|技术部': 'Technology', 'department|销售部': 'Sales',
  'department|制造部': 'Manufacturing', 'department|财务部': 'Finance', 'department|行政部': 'Administration', 'department|市场部': 'Marketing',
  'position|经理': 'Manager', 'position|主管': 'Supervisor', 'position|专员': 'Specialist', 'position|工程师': 'Engineer',
  'position|分析师': 'Analyst', 'position|销售代表': 'Sales Representative', 'position|HR专员': 'HR Specialist', 'position|财务专员': 'Finance Specialist',
  // 2026-08-13 补：用户新增/遗留选项
  'region|日本东京': 'Tokyo',
  'custom_2|M': 'Male', 'custom_2|F': 'Female',
  'department|hr_rl': 'HR Employee Relations Office',
};
let opt = 0;
for (const [fk, en] of Object.entries(OPTION_LABEL_EN)) {
  const [field, value] = fk.split('|');
  const r = db.prepare(`UPDATE field_dict_options SET label_en = ? WHERE field_key=? AND value=? AND (label_en IS NULL OR label_en='')`).run(en, field, value);
  opt += r.changes;
}
console.log(`[4b] 选项英文名补全 ${opt} 个`);

// ---------- 5. 密级档位 label_en（安全设置页档位，en 界面显示）----------
const LEVEL_LABEL_EN = { public: 'Public', internal: 'Internal', confidential: 'Confidential', top_secret: 'Top secret' };
{
  const raw = db.prepare("SELECT value FROM app_configs WHERE key='security.levels'").get();
  if (raw?.value) {
    try {
      const arr = JSON.parse(raw.value);
      let changed = false;
      if (Array.isArray(arr)) {
        for (const l of arr) {
          const en = LEVEL_LABEL_EN[String(l.value ?? '')];
          if (en && (!l.label_en || !String(l.label_en).trim())) { l.label_en = en; changed = true; }
        }
      }
      if (changed) db.prepare("UPDATE app_configs SET value=? WHERE key='security.levels'").run(JSON.stringify(arr));
      console.log(`[5] 密级档位 label_en 种子${changed ? '完成' : '（已存在，跳过）'}`);
    } catch { console.log('[5] security.levels 解析失败，跳过'); }
  } else {
    console.log('[5] security.levels 无配置，跳过');
  }
}

db.close();
console.log('迁移完成');
