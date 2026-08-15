// 意图识别（S5，PRD §2.6 意图模型；配置中心化 2026-08-06）
// 输出：{intents:[{intent, query, action_type, topic, flow}], missing_info?, contact_request?}
// 方案 B：intent（展示标题）与 query（检索词）分离；flow（流程）纯 LLM 识别（processes 字典动态注入）
import { getDb } from '../db/index.js';
import { getConfig, getNumber } from './config.js';
import { completeJSON } from './deepseek.js';

export interface IntentItem {
  intent: string;       // 意图标题（分节用）
  query: string;        // 检索词（调 /search 用）
  action_type: 'query' | 'contact' | 'process' | 'other';
  topic: string;        // 业务主题（policy_topics.id）
  flow: string | null;  // 流程 id（processes.id，process 意图时由 LLM 从流程字典选择）
}

export interface IntentResult {
  intents: IntentItem[];
  missing_info: string | null;  // 场景①：缺的信息（如"去哪个城市"）
  contact_request: boolean;     // L4：用户主动转人工/抱怨
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null; // 2026-08-09：意图识别 LLM 用量（token=全部 LLM 消耗口径）
}

/** 动态构建意图识别提示词：静态模板（app_configs 可配）+ 数据字典注入（主题/意图/流程） */
function buildIntentPrompt(): string {
  const template = getConfig('efficient.intent.prompt') ?? '';
  const db = getDb();
  const topics = db.prepare('SELECT id, name, scope FROM policy_topics WHERE enabled=1 ORDER BY sort').all() as { id: string; name: string; scope: string | null }[];
  const intents = db.prepare('SELECT id, prompt_desc FROM intent_types WHERE enabled=1 ORDER BY sort').all() as { id: string; prompt_desc: string }[];
  const procs = db.prepare('SELECT id, name FROM processes WHERE enabled=1 ORDER BY sort').all() as { id: string; name: string }[];
  const maxIntents = getNumber('efficient.intent.max_intents', 5);
  return template
    .replaceAll('{intent_types}', intents.map((i) => `${i.id}(${i.prompt_desc})`).join(' / '))
    .replaceAll('{topics}', topics.map((t) => `${t.id}(${t.name})`).join('、'))
    .replaceAll('{topic_scopes}', topics.map((t) => `${t.name}：${t.scope ?? '无'}`).join('；'))
    .replaceAll('{processes}', procs.map((p) => `${p.id}=${p.name}`).join('、'))
    .replaceAll('{max_intents}', String(maxIntents));
}

export async function recognizeIntents(question: string, history: any[] = [], user: any = null): Promise<IntentResult> {
  const timeout = getNumber('efficient.intent.timeout_ms', 20_000);
  // 带上最近 2 轮历史辅助理解（跨轮补全，如"那出差呢"依赖上轮主题）
  const recent = history.slice(-4);
  // S5 个性化：注入当前用户低敏感属性，供资格类问题（我能休…吗）判断是否缺信息（2026-08-06）
  const userHint = user
    ? `\n当前用户身份（仅供资格/适用性判断，低敏感字段）：地区=${user.region ?? '未知'}；层级=${user.level_type ?? '未知'}；合同类型=${user.contract_type ?? '未知'}；部门=${user.department ?? '未知'}`
    : '';
  // 2026-08-14：显式注入提问语言（字符集检测）——比 prompt 规则更可靠（规则 8 被 LLM 忽视时此注入兑底）
  const langInstr = /[\u4e00-\u9fa5]/.test(question)
    ? '\n用户提问语言：中文。query 与 intent 标题必须用中文。'
    : '\n用户提问语言：English。query 与 intent 标题必须用 English。';
  const msgs = [
    { role: 'system', content: buildIntentPrompt() + userHint + langInstr },
    ...recent,
    { role: 'user', content: question },
  ];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const { text, usage } = await completeJSON(msgs, { temperature: 0, timeoutMs: timeout });
    const result = parseIntentJson(text);
    // 2026-08-09：非流式响应 usage 现成，回传意图识别 token（高效模式 token=意图识别+生成）
    result.usage = usage;
    return result;
  } finally { clearTimeout(t); }
}

function parseIntentJson(text: string): IntentResult {
  // 兼容模型输出带 ```json 包裹
  const clean = text.replace(/```json|```/g, '').trim();
  try {
    const obj = JSON.parse(clean);
    const intents = (obj.intents ?? []).map((i: any) => ({
      intent: String(i.intent ?? ''),
      query: String(i.query ?? i.intent ?? ''),
      action_type: ['query', 'contact', 'process', 'other'].includes(i.action_type) ? i.action_type : 'query',
      topic: String(i.topic ?? 'other'),
      flow: i.flow ? String(i.flow) : null,
    }));
    return {
      intents,
      missing_info: obj.missing_info ? String(obj.missing_info) : null,
      contact_request: Boolean(obj.contact_request),
    };
  } catch {
    return { intents: [], missing_info: null, contact_request: false };
  }
}
