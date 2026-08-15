#!/usr/bin/env node
// 管理后台配置可理解性改造（2026-08-13，DISSCUSION 决策 / PRD §4.4.9）——幂等，重复跑无副作用
// 1) app_configs 加 hidden 列（隐藏标记：配置页不显示、读链保留——getConfig 按 key 直读不受影响）
// 2) 隐藏 4 项：l2_threshold（死配置，零消费）/ convert.timeout_ms / ingest.timeout_ms（工程参数，PRD §5.4 不暴露）/
//    branch.timeout_ms（内部实现细节）
// 3) 补 description + description_en（说人话：用途+默认+影响）
// 4) 改名 2 项：policy_grep 工具描述→检索工具说明；词法单次返回上限→单次检索返回条数上限
// 用法：node scripts/migrate-config-hidden.mjs（支持 SQLITE_PATH 指向测试库）
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(process.env.SQLITE_PATH || path.join(root, 'data', 'policybot.db'));

// ---------- 1) hidden 列（幂等） ----------
const cols = db.prepare('PRAGMA table_info(app_configs)').all().map((c) => c.name);
if (!cols.includes('hidden')) {
  db.exec('ALTER TABLE app_configs ADD COLUMN hidden INTEGER DEFAULT 0');
  console.log('[1] app_configs.hidden 列已添加');
} else {
  console.log('[1] app_configs.hidden 列已存在');
}

// ---------- 2) 隐藏 4 项（保留读链，配置页不再显示） ----------
const hide = db.prepare(`UPDATE app_configs SET hidden=1 WHERE key=? AND hidden<>1`);
for (const k of ['efficient.reply.l2_threshold', 'convert.timeout_ms', 'ingest.timeout_ms', 'efficient.branch.timeout_ms']) {
  const r = hide.run(k);
  if (r.changes) console.log(`[2] 隐藏：${k}`);
}

// ---------- 3) 补 description / description_en（说人话） ----------
const updDesc = db.prepare(`UPDATE app_configs SET description=?, description_en=? WHERE key=?`);
const DESCS = [
  ['efficient.retrieve.top_k', '进入回答生成的候选政策条款条数（默认 5）。越大回答越全面但越慢；问答效果正常时无需调整。', 'Number of candidate policy clauses fed into answer generation (default 5). Larger = more thorough but slower; no need to adjust when Q&A works fine.'],
  ['efficient.retrieve.fused_candidates', '混合检索后、精排前保留的候选条数（默认 20）。影响召回完整度与精排速度；一般无需调整。', 'Candidates kept after hybrid retrieval, before reranking (default 20). Affects recall completeness & rerank speed; usually no need to adjust.'],
  ['efficient.retrieve.rrf_k', '混合检索融合常数（默认 60）。影响关键词与语义两种结果的融合权重；一般无需调整。', 'Reciprocal Rank Fusion constant (default 60). Affects fusion weight between lexical and semantic results; usually no need to adjust.'],
  ['efficient.retrieve.bm25_k1', '关键词检索的词频饱和参数（默认 1.5）。一般无需调整。', 'BM25 term-frequency saturation parameter (default 1.5). Usually no need to adjust.'],
  ['efficient.retrieve.bm25_b', '关键词检索的长度归一参数（默认 0.75）。一般无需调整。', 'BM25 length-normalization parameter (default 0.75). Usually no need to adjust.'],
  ['efficient.intent.timeout_ms', '意图识别环节最长等待（毫秒，默认 20000）。超时则跳过意图识别继续回答。', 'Max wait for intent recognition (ms, default 20000). On timeout, intent recognition is skipped and answering continues.'],
  ['efficient.request.timeout_ms', '整轮问答请求的总超时（毫秒，默认 30000），含意图识别+检索+生成。', 'Total timeout for a Q&A request (ms, default 30000), covering intent recognition + retrieval + generation.'],
  ['efficient.retrieve.timeout_ms', '单次检索环节超时（毫秒，默认 30000）。通常无需调整。', 'Timeout for a single retrieval step (ms, default 30000). Usually no need to adjust.'],
  ['efficient.generate.timeout_ms', '回答生成环节超时（毫秒，默认 60000）。', 'Timeout for answer generation (ms, default 60000).'],
  ['common.session.expire_hours', '历史会话过期时长（小时，默认 24）。超过该时长的历史对话按过期处理。', 'History session expiry (hours, default 24). Conversations older than this are treated as expired.'],
  ['common.ui.stage_recognize', '问答过程中对话区域顶部显示的进度提示——理解问题阶段文案。', 'Progress text shown at the top of the chat area during Q&A — "understanding question" stage.'],
  ['common.ui.stage_retrieve', '问答过程中对话区域顶部显示的进度提示——检索政策阶段文案。', 'Progress text shown at the top of the chat area during Q&A — "retrieving policies" stage.'],
  ['common.ui.stage_generate', '问答过程中对话区域顶部显示的进度提示——组织回答阶段文案。', 'Progress text shown at the top of the chat area during Q&A — "organizing answer" stage.'],
  ['common.ui.stage_thinking', '问答过程中对话区域顶部显示的进度提示——智能模式思考阶段文案。', 'Progress text shown at the top of the chat area during Q&A — smart mode thinking stage.'],
  ['common.ui.stage_default', '问答过程中对话区域顶部显示的进度提示——默认/其他阶段文案。', 'Progress text shown at the top of the chat area during Q&A — default/other stage.'],
  ['efficient.reply.reject_text', '检索无结果时对用户显示的拒答文案。', 'Rejection message shown to users when no relevant policy content is found.'],
  ['efficient.reply.clarify_text', '信息不足需用户补充时，反问引导的提示文案。', 'Prompt shown when more information is needed from the user.'],
  ['efficient.reply.contact_text', '转人工时联系人的引导文案。', 'Guide text shown when transferring to a human contact.'],
  ['efficient.reply.topic_guide_text', '用户未说明业务主题时，引导其说明主题的文案。', 'Text guiding users to state their business topic when it is not provided.'],
  ['efficient.reply.action_process_text', '用户表达办理意图时，回答末尾推送的流程入口卡片文案。', 'Text for the process link card pushed at the end of answers when users intend to take action.'],
  ['efficient.reply.action_query_text', '查询类问题有对应流程时，回答末尾的弱提示文案（如"是否需要申请"）。', 'Soft prompt at the end of answers when a query has a related process (e.g., "Would you like to apply?").'],
  ['smart.prompt.clarify', '智能模式判断问题宽泛时，引导用户明确具体内容的提示词。', 'Prompt guiding the user to clarify specifics when a smart-mode question is vague.'],
  ['smart.prompt.process_dict', '告知智能模式 AI 有哪些业务流程入口的提示词（含 {processes} 变量）。', 'Prompt telling the smart-mode AI which business processes exist (includes {processes} variable).'],
  ['smart.prompt.profile', '注入当前用户信息的提示词（含 {profile_fields} 变量），供资格/适用性判断。', 'Prompt injecting current user info (includes {profile_fields} variable) for eligibility/application judgment.'],
  ['smart.prompt.risk', '风险提醒规则的提示词——回答涉及禁止性/强制性条款时追加「风险提示」区块。', 'Prompt for risk-reminder rules — appends a "risk warning" block when the answer involves prohibitive/mandatory clauses.'],
];
for (const [k, d, de] of DESCS) {
  const r = updDesc.run(d, de, k);
  if (r.changes) console.log(`[3] 补说明：${k}`);
}

// ---------- 4) 改名 2 项（label + label_en） ----------
const updName = db.prepare(`UPDATE app_configs SET label=?, label_en=?, description=?, description_en=? WHERE key=?`);
let n = updName.run('检索工具说明', 'Retrieval tool description',
  '指导智能模式 AI 如何检索政策库的说明（显示给 AI 的指令，非界面文案）；默认已调优。',
  'Instruction telling the smart-mode AI how to search the policy library (an instruction for the AI, not UI copy); tuned by default.',
  'smart.tool.policy_grep_desc').changes;
n += updName.run('单次检索返回条数上限', 'Max returns per search',
  '智能模式每次检索最多返回的政策条款条数（默认 10）。越大 AI 参考越多但越慢。',
  'Max policy clauses returned per smart-mode search (default 10). Larger = more for the AI to reference but slower.',
  'smart.retrieve.grep_top_n').changes;
console.log(`[4] 改名：${n} 项`);

// 校验
const hidden = db.prepare('SELECT key FROM app_configs WHERE hidden=1 ORDER BY key').all();
console.log('隐藏项：', hidden.map((r) => r.key).join(', ') || '（无）');
const noDesc = db.prepare("SELECT COUNT(*) c FROM app_configs WHERE module IN ('efficient','smart','common') AND (description IS NULL OR description='')").get().c;
console.log(`efficient/smart/common 无 description 剩余：${noDesc}`);
const renamed = db.prepare("SELECT key, label, label_en FROM app_configs WHERE key IN ('smart.tool.policy_grep_desc','smart.retrieve.grep_top_n')").all();
renamed.forEach((r) => console.log(`改名确认：${r.key} → ${r.label} / ${r.label_en}`));
db.close();
