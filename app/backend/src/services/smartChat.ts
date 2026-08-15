// 智能模式服务（S4）—— Pi SDK agent + policy_grep 自定义工具（词法检索）
// TECH.md §3.2 智能模式检索链路（2026-08-06 改）：agent 调 policy_grep → 词法匹配可见政策 chunk
// 权限封装点（B3）：agent 只能通过 policy_grep 访问政策，不暴露文件系统工具
import fs from 'node:fs';
import path from 'node:path';
import { createAgentSession, ModelRuntime, SessionManager, defineTool, DefaultResourceLoader, getAgentDir } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { getEffectiveVersionIds } from '../db/repo.js';
import { getVisibleLineIds, getApplicableState } from './permission.js';
import { getSearchableLineIds } from './security.js';
import { getConfig, getNumber } from './config.js';
import { getLLMConfig, PROVIDERS } from './model-config.js';
import { isLocalConfigured, LOCAL_LLM_BASE } from './local-llm.js';
import { buildProfileLines } from './profile.js';
import type { UserProfile } from '@policybot/shared';

// ============ 词法检索（路线 B，2026-08-06）：grep 风格 + 权限内过滤 ============
// 数据源：policy_chunks（content 含标题前缀 + section_path/anchor 引用三件套），不读文件系统
// 权限：S6 前全员可见（已发布且生效版本，与 browse 口径一致）；S6 接可见集合过滤
// 防探测：无权文件不在搜索集合内，结果"装不存在"与高效模式一致

/** 当前生效版本（按用户可见 line 过滤，S6 权限；口径唯一在 repo.getEffectiveVersionIds） */
function visibleVersions(user: UserProfile | null): Map<string, { name: string; line_id: string }> {
  const db = getDb();
  const ids = getEffectiveVersionIds();
  if (!ids.length) return new Map();
  const visible = getVisibleLineIds(user); // S6 权限：无权 line 不进入搜索集合（防探测装不存在）
  if (!visible.length) return new Map();
  // 密级（2026-08-12）：AI 可检索 = 可见 ∩ (无密级 或 策略 ai_searchable=true)——"人可读、AI 不引用"
  const searchable = getSearchableLineIds(user, visible);
  if (!searchable.length) return new Map();
  const rows = db.prepare(`
    SELECT v.id AS version_id, pl.name AS name, v.line_id AS line_id
    FROM policy_versions v JOIN policy_lines pl ON pl.id = v.line_id
    WHERE v.id IN (${ids.map(() => '?').join(',')}) AND v.line_id IN (${searchable.map(() => '?').join(',')})
  `).all(...ids, ...searchable) as { version_id: string; name: string; line_id: string }[];
  return new Map(rows.map((r) => [r.version_id, { name: r.name, line_id: r.line_id }]));
}

interface GrepHit {
  id: string;
  content: string;
  section: string;
  anchor: string;
  source: string;
  line_id: string;
  count: number;
  /** 适用范围三分态（2026-08-12）：工具返回前评估，用于重排+标注 */
  applicability?: 'applicable' | 'inapplicable' | 'neutral';
}

/** slug 与 parseAnchors 一致（去括号内容 + 空格转连字符 + 限长） */
function slugify(h: string): string {
  return h.replace(/[（(].*?[)）]/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'section';
}

/** 运行时把全文解析为章节块（标题 → 下一标题的内容），不依赖入库切片 */
function splitBlocks(md: string): { section: string; anchor: string; content: string }[] {
  const lines = md.split('\n');
  const blocks: { section: string; anchor: string; content: string }[] = [];
  const stack: { level: number; text: string; anchor: string }[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (!cur.length) return;
    blocks.push({
      section: stack.map((s) => s.text).join(' > '),
      anchor: stack.length ? stack[stack.length - 1].anchor : '',
      content: cur.join('\n').trim(),
    });
    cur = [];
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (m) {
      flush();
      const level = m[1].length;
      const text = m[2];
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text, anchor: slugify(text) });
    } else {
      cur.push(line);
    }
  }
  flush();
  return blocks;
}

/** 切片检索（2026-08-06 恢复，smart.retrieve.unit=chunk 时用）：在可见版本的 policy_chunks 上词法匹配，
 *  命中返回切片（含标题前缀 + section_path/anchor 引用三件套） */
function grepChunks(pattern: string, topN: number, user: UserProfile | null = null): GrepHit[] {
  const versionMap = visibleVersions(user);
  const versionIds = [...versionMap.keys()];
  if (!versionIds.length) return [];
  // 正则构造：合法则按正则解析；非法降级为转义后字面匹配
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  const db = getDb();
  const rows = db.prepare(`
    SELECT pc.id AS id, pc.content AS content, pc.section_path AS section, pc.anchor AS anchor, pc.version_id AS version_id
    FROM policy_chunks pc
    WHERE pc.retained=1 AND pc.version_id IN (${versionIds.map(() => '?').join(',')})
  `).all(...versionIds) as any[];
  const hits: GrepHit[] = [];
  for (const r of rows) {
    const m = r.content.match(re);
    if (!m) continue;
    const info = versionMap.get(r.version_id);
    hits.push({
      id: r.id, content: r.content, section: r.section ?? '', anchor: r.anchor ?? '',
      source: info?.name ?? '政策', line_id: info?.line_id ?? '', count: m.length,
    });
  }
  hits.sort((a, b) => b.count - a.count);
  return hits.slice(0, topN);
}

/** 按配置选择检索单元（smart.retrieve.unit：fulltext 全文 / chunk 切片） */
function grepByUnit(pattern: string, topN: number, user: UserProfile | null = null): GrepHit[] {
  return getConfig('smart.retrieve.unit', 'fulltext') === 'chunk' ? grepChunks(pattern, topN, user) : grepFullText(pattern, topN, user);
}

/** 全文词法检索（2026-08-06 改为全文）：对当前生效版本的 markdown 原文做正则匹配，
 *  命中返回完整章节块（标题→下一标题），引用定位到章节；不依赖入库切片 */
function grepFullText(pattern: string, topN: number, user: UserProfile | null = null): GrepHit[] {
  const versionMap = visibleVersions(user);
  if (!versionMap.size) return [];
  // 正则构造：合法则按正则解析；非法（如含特殊字符的关键词）降级为转义后字面匹配
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  const db = getDb();
  const hits: GrepHit[] = [];
  for (const [versionId, info] of versionMap) {
    const row = db.prepare('SELECT markdown_content FROM policy_versions WHERE id=?').get(versionId) as any;
    if (!row?.markdown_content) continue;
    let idx = 0;
    for (const b of splitBlocks(row.markdown_content)) {
      idx++;
      const m = b.content.match(re);
      if (!m) continue;
      hits.push({
        id: `ft:${versionId}:${idx}`,
        content: b.content,
        section: b.section,
        anchor: b.anchor,
        source: info.name,
        line_id: info.line_id,
        count: m.length,
      });
    }
  }
  hits.sort((a, b) => b.count - a.count);
  return hits.slice(0, topN);
}


// 模型运行时单例（Pi SDK 初始化较重，复用；配置变更后 invalidateSmartRuntime 重建）
let runtimePromise: Promise<ModelRuntime | null> | null = null;

/** 智能模式推理开关 → Pi SDK thinkingLevel（2026-08-13；导出供测试）
 * 云端智能思考显式控制：开='high' → deepseek thinkingFormat 分支 thinking:{type:'enabled'}；关='off' → thinking:{type:'disabled'} */
export function smartThinkingLevel(): 'high' | 'off' {
  return getConfig('smart.reasoning', '1') === '1' ? 'high' : 'off';
}

function getRuntime(): Promise<ModelRuntime | null> {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const cfg = getLLMConfig();
    // 2026-08-09 本地模式：runtime.registerProvider 注册 llama.cpp（ModelRuntime.create() 不含内置扩展 provider，
    //   原生方案 setRuntimeApiKey 会报"未找到 llama.cpp provider"；覆盖注册 + authHeader:false 是可用方式）
    if (cfg.mode === 'local') {
      if (!isLocalConfigured()) return null;
      const runtime = await ModelRuntime.create();
      runtime.registerProvider('llama.cpp', {
        api: 'openai-completions',
        baseUrl: `${LOCAL_LLM_BASE}/v1`,
        authHeader: false, // 本地无鉴权：关闭 authHeader 否则 Pi SDK 报 "No API key"
        apiKey: 'local',
        models: [{ id: cfg.model ?? 'local', name: cfg.model ?? 'local', reasoning: false, input: ['text'] as ('text' | 'image')[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 4096 }],
      });
      return runtime;
    }
    if (!cfg.apiKey) return null;
    const runtime = await ModelRuntime.create();
    const sdkId = cfg.provider; // Pi SDK provider id（custom 动态注册，其余内置同名）
    const isDefault = cfg.baseUrl === PROVIDERS[cfg.provider].baseUrl;
    const modelOverride = cfg.model
      ? [{ id: cfg.model, name: cfg.model, reasoning: true, input: ['text'] as ('text' | 'image')[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 4096 }]
      : undefined;
    if (cfg.provider === 'custom') {
      // 自定义 OpenAI 兼容：registerProvider 动态注册（Pi SDK 无内置 custom provider）
      // api 必须是 KnownApi：'openai-completions'（chat/completions 协议）——'openai' 非法会静默失败（No API provider registered）
      runtime.registerProvider('custom', { api: 'openai-completions', baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, models: modelOverride ?? [] });
    } else {
      // 内置 provider（deepseek/openai/anthropic 与 Pi SDK provider id 一致）
      // 2026-08-09 修复：setRuntimeApiKey 是 async（内部 await refresh 模型目录）——必须 await，
      // 否则与后续 registerProvider 存在竞态，auth 状态可能丢失 → "No API key found for anthropic"
      await runtime.setRuntimeApiKey(cfg.provider, cfg.apiKey);
      // 2026-08-09：自定义端点（如 DeepSeek 的 Anthropic 兼容 /anthropic、OpenAI 兼容代理）或指定模型
      // → extension 层覆盖内置 provider（baseUrl/models），api 实现（anthropic-messages/openai-completions）保留
      if (!isDefault || modelOverride) {
        runtime.registerProvider(cfg.provider, {
          baseUrl: isDefault ? undefined : cfg.baseUrl,
          models: modelOverride,
        });
      }
    }
    return runtime;
  })().catch(() => null);
  return runtimePromise;
}

/** 模型配置变更后调用（routes/model-config PUT 时），下次请求重建 runtime */
export function invalidateSmartRuntime(): void {
  runtimePromise = null;
}

export interface SmartEvent {
  kind: 'delta' | 'citations' | 'detail' | 'error' | 'reject' | 'done' | 'action' | 'status';
  text?: string;
  stage?: string;
  citations?: { idx: number; source: string; section: string; anchor: string; line_id?: string }[];
  retrieveMs?: number;
  firstTokenMs?: number; // 2026-08-09：首 token 延迟
  message?: string;
  toolCalls?: number;
  toolCallLog?: { name: string; args: any }[];
  tokensIn?: number;
  tokensOut?: number;
  action?: { link: string; text: string };
  emphasize?: boolean;
}

/** 智能模式：发起 agent 会话，事件流回调
 *  user（S5 个性化）：当前登录用户低敏感属性；空则不做个性化 */
export async function streamSmartChat(
  question: string,
  cb: (ev: SmartEvent) => void,
  webSessionId: string = '',
  user: UserProfile | null = null,
): Promise<void> {
  const runtime = await getRuntime();
  if (!runtime) { cb({ kind: 'error', message: '模型未配置' }); return; }
  const llm = getLLMConfig();
  // 2026-08-09 本地模式：Pi SDK provider id = llama.cpp（getRuntime 已注册）；云端用 llm.provider
  const sdkProvider = llm.mode === 'local' ? 'llama.cpp' : llm.provider;
  const provider = runtime.getProvider(sdkProvider);
  if (!provider) { cb({ kind: 'error', message: `未找到 ${sdkProvider} provider` }); return; }
  let model;
  try {
    const models = provider.getModels();
    // 配置了具体模型 → 精确匹配；未匹配/未配置 → 取第一个可用
    model = llm.model ? models.find((m: any) => m.id === llm.model) : undefined;
    if (!model) model = models[0];
  } catch { model = undefined; }
  if (!model) { cb({ kind: 'error', message: '未找到可用模型' }); return; }

  // policy_grep 工具（2026-08-06，路线 B）：词法检索可见政策 chunk → 返回命中片段（含来源/章节）
  // 权限：visibleLineIds() 实时算当前用户可见集合（S6 前全员可见）；无权内容不进入搜索集合
  // 工具描述从配置读（smart.tool.policy_grep_desc，可调优）
  const policyGrep = defineTool({
    name: 'policy_grep',
    label: 'Policy Grep',
    description: getConfig('smart.tool.policy_grep_desc') ?? `在企业政策库全文内容中按关键词或正则检索（类似 grep），返回命中的政策条款片段及来源章节。
用法：
- 多个同义词/近义词用 | 连接（如：年假|年休假|带薪年休），提高召回
- 一次检索一个概念，复杂问题分多次检索再综合
- 查条款编号、专有名词时直接搜精确词（如：第三条、员工福利）
仅依据检索返回的政策原文回答，不要臆造；回答时用 [编号] 标注来源章节。`,
    parameters: Type.Object({
      pattern: Type.String({ description: '检索词或正则，多个同义词用 | 连接，如"年假|年休假|带薪年休"' }),
      top_n: Type.Optional(Type.Number({ description: '最多返回命中条数' })),
    }),
    execute: async (_callId, params: { pattern?: string; top_n?: number }) => {
      const hits = grepByUnit(params?.pattern ?? '', params?.top_n ?? getNumber('smart.retrieve.grep_top_n', 10), user);
      if (!hits.length) {
        return {
          content: [{ type: 'text', text: getConfig('efficient.reply.reject_text') ?? '未在政策库中找到相关内容。' }],
          details: { hits: 0 },
        } as any;
      }
      // 适用范围标注重排（2026-08-12，落地 C1）：对每命中按 apply_rules 三分态 → 适用组→未知组→不适用组（组内 count 降序）
      // 机制保证 agent 优先看适用条款；不适用条款不删除（agent 需解释"为什么不适用"，profile 注入提供属性）
      const lineIds = [...new Set(hits.map((h) => h.line_id))];
      const lineRows = getDb().prepare(`SELECT id, library_id, apply_rules FROM policy_lines WHERE id IN (${lineIds.map(() => '?').join(',')})`).all(...lineIds) as { id: string; library_id: string; apply_rules: string | null }[];
      const lineMap = new Map(lineRows.map((r) => [r.id, r]));
      const marked = hits.map((h) => ({ ...h, applicability: (lineMap.get(h.line_id) ? getApplicableState(lineMap.get(h.line_id)!, user) : 'neutral') as 'applicable' | 'inapplicable' | 'neutral' }));
      const groupOrder = { applicable: 0, neutral: 1, inapplicable: 2 } as const;
      marked.sort((a, b) => groupOrder[a.applicability] - groupOrder[b.applicability] || b.count - a.count);
      const label = (st: string) => (st === 'applicable' ? '【适用于您】' : st === 'inapplicable' ? '【不适用于您】' : '');
      // 拼成带编号引用的文本供 agent 引用
      const text = marked.map((h, i) => `[${i + 1}] 来源：《${h.source}》${h.section ? ' ' + h.section : ''}${label(h.applicability)}
${h.content}`).join('\n\n');
      return {
        content: [{ type: 'text', text }],
        details: { hits: marked.length, retrieved: marked.map((h) => ({ id: h.id, source: h.source, section: h.section, anchor: h.anchor, line_id: h.line_id, applicability: h.applicability })) },
      } as any;
    },
  });

  // 会话持久化：一个 Web 对话 = 一个 Pi session（按 webSessionId 存取，跨请求复用）
  // Pi SDK 文件名格式 <timestamp>_<id>.jsonl，需扫描目录按 id 匹配
  const sessionDir = path.join(config.root, 'data', 'pi-sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  const safeId = (webSessionId || 'anon').replace(/[^\w-]/g, '_');
  const existingFile = fs.readdirSync(sessionDir).find((f) => f.endsWith(`_${safeId}.jsonl`));
  const isNewSession = !existingFile; // 新会话首次注入规则；旧会话（多轮）只发用户问题，避免规则文本每轮膨胀撑爆上下文
  const sessionManager = existingFile
    ? SessionManager.open(path.join(sessionDir, existingFile), sessionDir)
    : SessionManager.create(config.root, sessionDir, { id: safeId });
  // 2026-08-11 诊断：智能模式本地模型不调工具排查——打印运行时关键状态
  console.log(`[smart-diag] sdkProvider=${sdkProvider} model=${model?.id ?? 'N/A'} isNewSession=${isNewSession} existingFile=${existingFile ?? '无'} runtime=${!!runtime}`);

  // 自定义 resourceLoader：极简（不加载项目扩展/技能/主题），注入可配置的 agent 角色设定
  // （smart.prompt.system，2026-08-06；Pi SDK 默认 system prompt 不可直接改，走 systemPromptOverride）
  const resourceLoader = new DefaultResourceLoader({
    cwd: config.root,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: (base) => getConfig('smart.prompt.system') ?? base ?? undefined,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    model,
    modelRuntime: runtime,
    tools: ['policy_grep'],
    customTools: [policyGrep],
    sessionManager,
    resourceLoader,
    // 2026-08-13 模型推理开关（smart.reasoning，默认开）：云端智能思考显式控制——
    // 开='high' → deepseek thinkingFormat 分支 thinking:{type:'enabled'}；关='off' → thinking:{type:'disabled'}
    // 本地模式不经此参数（引擎 --reasoning 由 smart.reasoning 派生，local-llm.ts）
    ...(getLLMConfig().mode === 'cloud' ? { thinkingLevel: smartThinkingLevel() } : {}),
  });

  let toolCalls = 0;
  let toolCallLog: { name: string; args: any }[] = [];
  let retrieveMs = 0;      // 2026-08-09：工具（policy_grep）执行总耗时（检索耗时语义）
  let firstTokenMs: number | undefined; // 2026-08-09：首 token 延迟（第一个 delta；原 retrieveMs 误记为它）
  let toolStart = 0;       // 工具执行开始（累加耗时用）
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;
  const t0 = Date.now();
  let firstDelta = true;
  let citationsSent = false;

  session.subscribe((event: any) => {
    // 流式文本
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
      const delta = event.assistantMessageEvent.delta ?? '';
      if (firstDelta) { firstDelta = false; firstTokenMs = Date.now() - t0; }
      cb({ kind: 'delta', text: delta });
    }
    if (event.type === 'tool_execution_start') {
      toolCalls++;
      toolStart = Date.now();
      toolCallLog.push({ name: event.toolName ?? 'policy_grep', args: event.args ?? {} });
      console.log(`[smart-diag] tool_execution_start ${event.toolName} args=${JSON.stringify(event.args ?? {})?.slice(0, 120)}`);
    }
    if (event.type === 'tool_execution_end') {
      if (toolStart) retrieveMs += Date.now() - toolStart;
      toolStart = 0;
      // 工具完成：拿检索结果发引用（从工具返回的 details）
      const detail = event.result?.details;
      if (detail?.retrieved && !citationsSent) {
        citationsSent = true;
        cb({ kind: 'citations', citations: detail.retrieved.map((h: any, i: number) => ({ idx: i + 1, source: h.source ?? '', section: h.section ?? '', anchor: h.anchor ?? '', line_id: h.line_id })) });
      }
    }
  });

  try {
    // 宽泛问题先澄清（Pi session 已自带历史，不再手动注入）
    // 宽泛先澄清（提示词可配置：smart.prompt.clarify）
    const clarifyTemplate = getConfig('smart.prompt.clarify') ?? `请先判断用户问题是否宽泛模糊：如果问题只提到主题（如"休假""出差""报销"）而未指明具体想了解什么（如"年假几天""住宿标准""报销流程"），**不要一次性检索并列举该主题下所有政策内容**，而应先用简短的话引导用户明确具体想了解的内容，例如"您想了解哪类假期？年假/婚假/产假/病假？"。`;
    const clarifyPrompt = `${clarifyTemplate}\n\n用户问题：${question}`;
    // S5 个性化（方案 A：低敏感字段，仅资格判断场景使用；提示词可配置：smart.prompt.profile；2026-08-11 动态化遍历启用字段含预留 custom_1~10）
    const profileFields = user ? buildProfileLines(user) : '';
    const profileTemplate = getConfig('smart.prompt.profile') ?? `\n\n当前用户信息（仅供判断该用户个人资格/适用性，如"我能否享受""适用我吗"等；回答一般性政策问题时不必刻意提及，也不得主动透露用户身份信息）：{profile_fields}\n要求：只回答当前用户本人的情况，不得推测或编造其他任何人的信息。`;
    const profilePrompt = user ? profileTemplate.replaceAll('{profile_fields}', profileFields) : '';
    // S5 风险提醒（仅智能模式；提示词可配置：smart.prompt.risk）
    const riskPrompt = getConfig('smart.prompt.risk') ?? `\n\n风险提醒规则：如果您的回答涉及政策中的禁止性或强制性条款（含"禁止""不得""严禁""必须"等措辞），请在回答末尾追加一个「⚠️ 风险提示」区块，包含：\n- 政策依据：引用相关条款及来源章节\n- 可能后果：仅陈述政策中写明的后果（如无则省略）\n- 正确做法：给出合规操作建议\n要求：只依据政策原文，不添加政策外风险；语气客观，不评判用户。`;
    // 流程字典注入（2026-08-06：纯 LLM 识别流程，agent 自主推送链接；提示词可配置：smart.prompt.process_dict）
    const procRows = getDb().prepare('SELECT name, url FROM processes WHERE enabled=1 ORDER BY sort').all() as { name: string; url: string }[];
    const procDict = procRows.map((p) => `${p.name}：${p.url}`).join('；');
    const procTemplate = getConfig('smart.prompt.process_dict') ?? '';
    const procPrompt = procTemplate.replaceAll('{processes}', procDict);
    // 联系人字典注入（2026-08-06：智能模式转人工能力；提示词可配置：smart.prompt.contact_dict）
    // 仅用户明确要求人工/转人工/不满意/投诉时推送联系人；一般问答不推、不编造联系人
    // 2026-08-11：region 多选（JSON 数组）——兼容旧单值（JSON_VALID 走 json_each 包含、否则精确匹配）；
    //   地区级路由（覆盖用户地区）优先，主题无地区级才用主题级兑底，每主题至多一条（避免 agent 选错）
    const userRegion = user?.region ?? null;
    const regionMatch = (col: string) =>
      `(${col} = ? OR (JSON_VALID(${col}) AND EXISTS (SELECT 1 FROM json_each(${col}) WHERE json_each.value = ?)))`;
    const selContact = `
      SELECT pt.name AS topic_name, u.name AS cname, u.department AS cdept, u.email AS cemail, u.phone AS cphone
      FROM topic_routes tr
      JOIN policy_topics pt ON pt.id = tr.topic_id
      JOIN users u ON u.id = tr.contact_user_id
      WHERE tr.enabled = 1`;
    // 地区级路由（覆盖用户地区；地区未知则无）
    const regionRows = (userRegion
      ? getDb().prepare(`${selContact} AND ${regionMatch('tr.region')} ORDER BY tr.sort`).all(userRegion, userRegion)
      : []) as { topic_name: string; cname: string; cdept: string | null; cemail: string | null; cphone: string | null }[];
    // 主题级兑底（该主题无任何覆盖用户地区的地区级路由时）
    const fallbackRows = getDb().prepare(`${selContact}
      AND (tr.region IS NULL OR tr.region='' OR tr.region='[]')
      AND NOT EXISTS (
        SELECT 1 FROM topic_routes t2 WHERE t2.topic_id = tr.topic_id AND t2.enabled = 1 AND ${regionMatch('t2.region')}
      )
      ORDER BY tr.sort`).all(userRegion, userRegion) as { topic_name: string; cname: string; cdept: string | null; cemail: string | null; cphone: string | null }[];
    const contactRows = [...fallbackRows, ...regionRows];
    const contactDict = contactRows.map((c) => `${c.topic_name}：${c.cname}（${c.cdept ?? ''}${c.cemail ? ' ' + c.cemail : ''}${c.cphone ? ' ' + c.cphone : ''}）`).join('；');
    const contactTemplate = getConfig('smart.prompt.contact_dict') ?? `\n\n转人工规则：仅当用户明确要求人工协助、转人工、对回答不满意或投诉时，才推送对应业务主题的联系人；用户未说明业务主题时，先询问主题（如：出差、考勤、报销、外派）。一般政策问答不要主动推送联系人，不得编造联系人信息，联系人仅限以下字典。联系人字典：{contacts}`;
    const contactPrompt = contactRows.length ? contactTemplate.replaceAll('{contacts}', contactDict) : '';
    // 多轮注入策略（2026-08-06 修复）：规则（澄清/个性化/风险/流程/联系人）仅新会话注入一次；
    // 2026-08-09：token=本轮全部 LLM 消耗——消息数基线法（Pi session 跨轮累积，只能汇总本轮新增，否则算进历史轮次）
    const baselineCount = (session.messages ?? []).length;
    // 旧会话只发用户问题——规则已保留在 agent 历史中持续生效，每轮重复注入会把上下文撑爆触发压缩丢失早期对话
    if (isNewSession) {
      await session.prompt(clarifyPrompt + profilePrompt + riskPrompt + procPrompt + contactPrompt);
    } else {
      await session.prompt(question);
    }
    // 2026-08-09 防护：Pi SDK 模型调用失败常是静默的（消息 stopReason=error，不抛异常、无流输出）——
    // 检查本轮最后一条 assistant 消息，error 则向客户端发 error 事件（避免"白屏不回答"）
    const lastMsg: any = (session.messages ?? []).slice(-1)[0];
    if (lastMsg?.role === 'assistant' && (lastMsg.stopReason === 'error' || lastMsg.errorMessage)) {
      cb({ kind: 'error', message: lastMsg.errorMessage ?? '模型调用失败（' + (lastMsg.stopReason ?? 'unknown') + '）' });
      return;
    }
    // 汇总本轮新增消息的 usage（agent 思考+工具循环多次 LLM 调用，全部计入）
    try {
      const msgs: any[] = session.messages ?? [];
      let tin = 0, tout = 0;
      for (const m of msgs.slice(baselineCount)) {
        const u = m?.usage;
        if (u) {
          tin += u.input ?? u.prompt_tokens ?? 0;
          tout += u.output ?? u.completion_tokens ?? 0;
        }
      }
      if (tin || tout) { tokensIn = tin; tokensOut = tout; }
    } catch { /* usage 拿不到则留空 */ }
    cb({ kind: 'detail', retrieveMs, firstTokenMs, toolCalls, toolCallLog, tokensIn, tokensOut });
    // 场景②行动建议：纯 LLM（2026-08-06）——流程字典已注入 agent prompt，由 agent 自主在回答中推送链接
    cb({ kind: 'done' });
  } catch (e: any) {
    cb({ kind: 'error', message: String(e?.message ?? e) });
  } finally {
    // 不 dispose：保留会话文件（跨请求复用靠它），agent 自带记忆
    // 会话清理策略（轮数/过期）后续评估
  }
}