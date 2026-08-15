// /api/chat 问答主入口（S3）—— TECH.md §3.1 检索链路 + PRD §4.4.3 生成与引用
// 流程：提问 → Python /search → 无命中拒答 → 否则组装上下文 → DeepSeek 流式 SSE → 后续存消息+防幻觉校验
import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import { newId } from '../db/repo.js';
import { logger } from '../services/logger.js';
import { streamDeepseek } from '../services/deepseek.js';
import { streamSmartChat } from '../services/smartChat.js';
import { runEfficientGraph, setEmit } from '../services/orchestrator.js';
import { getNumber, getConfig, getConfigLocalized } from '../services/config.js';
import { config } from '../config.js';
import { E, sendErr } from '../services/errors.js';

export const chatRouter = Router();

const PYTHON_BASE = config.pythonBaseUrl;

interface SearchHit {
  id: string;
  content: string;
  source: string;
  section: string;
  anchor: string;
  has_table: boolean;
  score: number;
  line_id: string;
}

async function callPythonSearch(query: string): Promise<{ results: SearchHit[]; raw: any; tookMs: number }> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), getNumber('efficient.request.timeout_ms', 30_000));
  try {
    const res = await fetch(`${PYTHON_BASE}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, top_k: 5 }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Python /search ${res.status}: ${txt}`);
    }
    const raw = await res.json();
    return { results: raw.results ?? [], raw, tookMs: Date.now() - t0 };
  } finally {
    clearTimeout(t);
  }
}

// 组装技术详情事件数据（PRD §4.4.6：召回片段 + rerank 前后变化）
function buildDetailPayload(raw: any, retrieveMs: number, latencyMs?: number, tokensIn?: number, tokensOut?: number, hits: SearchHit[] = []) {
  // 用 hits（含 section/source）为召回片段补充来源
  const hitMap = new Map(hits.map((h) => [h.id, h]));
  const list = (raw?.reranked ?? raw?.fused_top20 ?? []).slice(0, 10);
  return {
    kind: 'detail',
    retrieveMs,
    latencyMs,
    tokensIn: tokensIn ?? null,
    tokensOut: tokensOut ?? null,
    bm25Count: raw?.bm25_top20?.length ?? 0,
    vectorCount: raw?.vector_top20?.length ?? 0,
    fusedCount: raw?.fused_top20?.length ?? 0,
    rerankedCount: (raw?.reranked?.length ?? 0),
    // 召回片段详情（技术详情面板用）
    retrieved: list.map((x: any, i: number) => {
      const h = hitMap.get(x.id);
      return {
        rank: i + 1, id: x.id, score: x.rerank_score ?? x.fused_score ?? x.score ?? 0,
        source: h?.source ?? '', section: h?.section ?? '',
      };
    }),
  };
}

// POST /api/chat —— SSE 流式
chatRouter.post('/chat', async (req: Request, res: Response) => {
  const { question } = req.body ?? {};
  const mode = (req.body?.mode ?? 'efficient') as string;
  if (!question?.trim()) { sendErr(req, res, 400, E('CHAT_QUESTION_REQUIRED', 'question 必填', 'question is required')); return; }
  // 2026-08-11：高效模式开关（efficient.mode.enabled）——关闭后拒绝高效请求（防绕过；前端已隐藏入口）
  if (mode === 'efficient' && getNumber('efficient.mode.enabled', 1) !== 1) {
    sendErr(req, res, 403, E('CHAT_EFFICIENT_DISABLED', '高效模式已停用，请开启新对话', 'Efficient mode is disabled. Please start a new chat'));
    return;
  }
  // 2026-08-09 修复：高效轮数上限检查必须在 SSE 头设置之前（flushHeaders 后无法再改状态码，
  //   原放在高效分支导致 ERR_HTTP_HEADERS_SENT、状态仍 200——轮数上限实际未生效）
  if (mode === 'efficient') {
    const sessionId = req.sessionId;
    const historyRows = getDb().prepare(
      `SELECT role FROM messages WHERE session_id=? AND user_id=? ORDER BY created_at ASC`,
    ).all(sessionId, req.user?.id ?? 'anonymous') as { role: string }[];
    const roundLimit = getNumber('efficient.generate.max_rounds', 5);
    const usedRounds = historyRows.filter((r) => r.role === 'assistant').length; // 用户问+AI答=1轮
    if (usedRounds >= roundLimit) {
      logger.chat({ sessionId, messageId: '', question: String(question).slice(0, 200), answer: `轮数上限（已达 ${usedRounds}/${roundLimit} 轮）`, mode: 'efficient', rejected: 1 });
      sendErr(req, res, 429, E('CHAT_ROUND_LIMIT', `该对话已达 ${roundLimit} 轮上限（高效模式限制，智能模式无此限制），请开启新对话`, `This conversation has reached the ${roundLimit}-round limit (efficient mode only; smart mode has no limit). Please start a new chat`));
      return;
    }
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const sessionId = req.sessionId;

  // 智能模式分支（S4）：Pi SDK agent + policy_lookup 工具（mode 已在开头解析）
  if (mode === 'smart') {
    const db = getDb();
    const messageId = newId();
    db.prepare('INSERT OR IGNORE INTO conversations (id, updated_at) VALUES (?, datetime(\'now\'))').run(sessionId);
    const t0smart = Date.now();
    let answer = '';
    let firstTokenMs: number | null = null; // 2026-08-09：智能模式首 token 延迟（含 agent 思考+工具调用时间，设计特性）
    const citations: any[] = [];
    // 2026-08-09 修复：收集智能模式性能指标（原 saveMessage 只传 mode/rejected，latency/token 全丢 → 统计无智能模式平均响应）
    let smartMeta: { tokensIn?: number; tokensOut?: number; retrieveMs?: number } = {};
    try {
      const smartHandler = (ev: import('../services/smartChat.js').SmartEvent) => {
        if (ev.kind === 'delta' && ev.text) { if (firstTokenMs == null) firstTokenMs = Date.now() - t0smart; answer += ev.text; res.write(`data: ${JSON.stringify({ kind: 'delta', text: ev.text })}\n\n`); }
        else if (ev.kind === 'citations') { citations.push(...(ev.citations ?? [])); res.write(`data: ${JSON.stringify({ kind: 'citations', citations: ev.citations })}\n\n`); }
        else if (ev.kind === 'detail') { smartMeta = { tokensIn: ev.tokensIn, tokensOut: ev.tokensOut, retrieveMs: ev.retrieveMs }; res.write(`data: ${JSON.stringify({ ...ev, latencyMs: Date.now() - t0smart, sessionId, firstTokenMs })}\n\n`); }
        else if (ev.kind === 'error') { res.write(`data: ${JSON.stringify({ kind: 'error', message: ev.message })}\n\n`); }
        else if (ev.kind === 'reject') { res.write(`data: ${JSON.stringify({ kind: 'reject', message: ev.message })}\n\n`); }
        else if (ev.kind === 'action') { res.write(`data: ${JSON.stringify({ kind: 'action', action: ev.action, emphasize: ev.emphasize })}\n\n`); }
        else if (ev.kind === 'status') { res.write(`data: ${JSON.stringify({ kind: 'status', stage: ev.stage })}\n\n`); }
      };
      await streamSmartChat(question, smartHandler, sessionId, req.user ?? null);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e: any) {
      res.write(`data: ${JSON.stringify({ kind: 'error', message: String(e?.message ?? e) })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
    // 存历史（user + assistant 两行）——含性能指标（latency/tokens/retrieve）
    // 存历史（user + assistant 两行）——含性能指标（latency/tokens/retrieve）
    // 2026-08-09 修复：智能拒答标记——smartChat 从不发 reject 事件、原硬编码 rejected=0。
    //   判定=**结构化引用信号**：回答含政策编号（如 POL-005）或《X》后紧跟条款/规定词（第X条/章/条款/规定/标准）
    //   ——正常回答必带具体引用；无关/拒答回答即使列举政策名（如《考勤管理办法》等）也不算引用（无条款定位）
    const hasCitation = /[A-Z]{2,}-\d+/.test(answer) || (() => {
      const m = answer.match(/《[^》]+》/);
      if (!m || m.index == null) return false;
      const after = answer.slice(m.index + m[0].length, m.index + m[0].length + 40);
      return /第[一二三四五六七八九十百\d]+[条章节]|条款|规定|标准/.test(after);
    })();
    const smartRejected = hasCitation ? 0 : 1;
    saveMessage(db, messageId, sessionId, question, answer || '（无回答）', citations, {
      mode: 'smart', rejected: smartRejected,
      latencyMs: Date.now() - t0smart,
      tokensIn: smartMeta.tokensIn, tokensOut: smartMeta.tokensOut,
      retrieveMs: smartMeta.retrieveMs, firstTokenMs,
    }, req.user?.id ?? 'anonymous');
    logger.chat({ sessionId, messageId, question, answer: (answer || '').slice(0, 200), mode: 'smart' });
    return;
  }

  // ===== 高效模式（S5 LangGraph 编排）=====
  const messageId = newId();
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO conversations (id, updated_at) VALUES (?, datetime(\'now\'))').run(sessionId);

  // 读取多轮历史（含 assistant 反问/回答）+ 轮数上限检查（S5：默认 5 轮，可配置）
  // 取完整历史（user+assistant），让 LLM 理解"宁波"是对反问的补充
  const historyRows = db.prepare(
    `SELECT role, question, content FROM messages WHERE session_id=? AND user_id=? ORDER BY created_at ASC`,
  ).all(sessionId, req.user?.id ?? 'anonymous') as { role: string; question: string; content: string }[];
  const roundLimit = getNumber('efficient.generate.max_rounds', 5);
  // 每轮 = 2 条（user + assistant），取最近 (roundLimit-1) 轮的完整消息
  const maxMsgs = (roundLimit - 1) * 2;
  const recentRows = historyRows.slice(-maxMsgs);
  const historyMessages = recentRows.map((r) => ({
    role: r.role,
    // user 行用 question（原问题），assistant 行用 content（反问/回答）
    content: r.role === 'user' ? (r.question ?? r.content) : r.content,
  }));

  try {
    const t0 = Date.now();
    let answer = '';
    let firstTokenMs: number | null = null; // 2026-08-09：首 token 延迟——第一个 delta 事件到达时间（高效=生成阶段开始）
    // 真流式 + 阶段状态：图执行中实时转发
    setEmit((ev) => {
      if (ev.kind === 'status') {
        res.write(`data: ${JSON.stringify({ kind: 'status', stage: ev.stage })}\n\n`);
      } else if (ev.kind === 'delta' && ev.text) {
        if (firstTokenMs == null) firstTokenMs = Date.now() - t0;
        answer += ev.text;
        res.write(`data: ${JSON.stringify({ kind: 'delta', text: ev.text })}\n\n`);
      }
    });
    const result = await runEfficientGraph({ question, messages: historyMessages, user: req.user ?? null });
    // 2026-08-09：token=本轮全部 LLM 消耗 = 意图识别 + 生成（拒答/反问等路径仅意图识别）
    const intentUsage = result.intentUsage ?? null;
    const intentIn = intentUsage?.prompt_tokens ?? 0;
    const intentOut = intentUsage?.completion_tokens ?? 0;

    // 场景①：缺信息反问（不检索）→ 提示补充，不带引用
    if (result.missingInfo) {
      // 2026-08-11 修复：反问也发 detail（此前拒答/反问/转人工路径不发 detail → 前端无技术详情按钮，PRD §4.4.6 每次回答都有）
      res.write(`data: ${JSON.stringify({ kind: 'detail', rejected: true, retrieveMs: result.retrieveMs ?? null, latencyMs: Date.now() - t0, tokensIn: intentIn || null, tokensOut: intentOut || null, firstTokenMs, sessionId, bm25Count: 0, vectorCount: 0, fusedCount: 0, rerankedCount: 0 })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      saveMessage(db, messageId, sessionId, question, answer, [], { rejected: 1, tokensIn: intentIn || null, tokensOut: intentOut || null, latencyMs: Date.now() - t0 }, req.user?.id ?? 'anonymous');
      logger.chat({ sessionId, messageId, question, answer: answer.slice(0, 200), mode: 'efficient', rejected: 1 });
      return;
    }

    // L4 转人工 / 拒答 / 低置信：回答 + 联系人卡片
    if (result.contactRequest || result.rejected) {
      // 文本兜底：answer 为空时发默认拒答文案（防止空白）
      const text = answer?.trim() ? answer : (getConfigLocalized('efficient.reply.reject_text', result.language) ?? '未在政策库中找到相关内容。');
      if (!answer?.trim()) res.write(`data: ${JSON.stringify({ kind: 'delta', text })}\n\n`);
      if (result.route) {
        // 2026-08-09：contact payload 补主题名（前端明确显示是什么主题的联系人，如【假期】联系人）
        res.write(`data: ${JSON.stringify({ kind: 'contact', contact: { name: result.route.contact_name, dept: result.route.contact_dept, contact: result.route.contact_contact, action_link: result.route.action_link, topic: result.route.topic_name } })}\n\n`);
      }
      // 2026-08-11 修复：拒答/转人工也发 detail（此前不发 → 前端无技术详情按钮；retrieveMs 转人工/无关拒答为 0，检索 0 命中拒答有实际值）
      res.write(`data: ${JSON.stringify({ kind: 'detail', rejected: true, retrieveMs: result.retrieveMs ?? null, latencyMs: Date.now() - t0, tokensIn: intentIn || null, tokensOut: intentOut || null, firstTokenMs, sessionId, bm25Count: result.searchRaw?.bm25_top20?.length ?? 0, vectorCount: result.searchRaw?.vector_top20?.length ?? 0, fusedCount: result.searchRaw?.fused_top20?.length ?? 0, rerankedCount: result.searchRaw?.reranked?.length ?? 0 })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      saveMessage(db, messageId, sessionId, question, text, [], { rejected: 1, tokensIn: intentIn || null, tokensOut: intentOut || null, latencyMs: Date.now() - t0, retrieveMs: result.retrieveMs ?? null }, req.user?.id ?? 'anonymous');
      logger.chat({ sessionId, messageId, question, answer: text.slice(0, 200), mode: 'efficient', rejected: 1 });
      return;
    }

    // 正常回答：引用 + 详情（生成已实时流式）
    const citations = result.mergedChunks.slice(0, 5).map((h: any, i: number) => ({ idx: i + 1, chunk_id: h.id, line_id: h.line_id, source: h.source, section: h.section, anchor: h.anchor }));
    if (citations.length) res.write(`data: ${JSON.stringify({ kind: 'citations', citations })}\n\n`);
    // 2026-08-09 修复：detail 参数修正——retrieveMs=检索 wall-clock（result.retrieveMs）、latencyMs=完整耗时（Date.now()-t0，原传 undefined 且把完整耗时误作 retrieveMs）；
    //   tokensIn/Out=合计（意图识别+生成），另带 firstTokenMs 与 intentTokens 分项（前端透明展示）
    const genIn = result.usage?.prompt_tokens ?? 0;
    const genOut = result.usage?.completion_tokens ?? 0;
    const totalIn = intentIn + genIn;
    const totalOut = intentOut + genOut;
    res.write(`data: ${JSON.stringify({ ...buildDetailPayload(result.searchRaw, result.retrieveMs ?? 0, Date.now() - t0, totalIn, totalOut, result.mergedChunks), sessionId, firstTokenMs, intentTokensIn: intentIn, intentTokensOut: intentOut })}\n\n`);
    // 场景②：行动建议链接（process=主卡片 / query-link=弱提示）——流程来自 processes 表（纯 LLM flow 识别）
    if (result.actionType !== 'none' && result.process?.url) {
      const isProcess = result.actionType === 'process';
      const text = isProcess
        ? (getConfigLocalized('efficient.reply.action_process_text', result.language) ?? '前往办理')
        : (getConfigLocalized('efficient.reply.action_query_text', result.language) ?? '是否需要申请？');
      // 2026-08-09：action payload 补流程名（前端明确显示是什么流程，如「请假申请」）
      res.write(`data: ${JSON.stringify({ kind: 'action', action: { link: result.process.url, text, name: result.process.name }, emphasize: isProcess })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();

    // 防幻觉校验 + 存历史
    const citedNums = Array.from(answer.matchAll(/\[(\d+)\]/g)).map((m: any) => Number(m[1]));
    const citedChunks = citedNums.filter((n) => n >= 1 && n <= result.mergedChunks.length).map((n) => result.mergedChunks[n - 1]);
    const hallucination = citedNums.length > 0 && citedChunks.length < citedNums.length ? 1 : 0;
    saveMessage(db, messageId, sessionId, question, answer, citations, {
      latencyMs: Date.now() - t0, citedCount: citedChunks.length, hallucination,
      // 2026-08-09：token=全部 LLM 消耗（意图识别+生成）、检索 wall-clock、首 token 延迟
      tokensIn: totalIn || null, tokensOut: totalOut || null,
      retrieveMs: result.retrieveMs ?? null, firstTokenMs,
    }, req.user?.id ?? 'anonymous');
    logger.chat({ sessionId, messageId, question, answer: answer.slice(0, 200), mode: 'efficient', hallucination });
  } catch (e: any) {
    res.write(`data: ${JSON.stringify({ kind: 'error', message: String(e?.message ?? e) })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    saveMessage(db, messageId, sessionId, question, '错误：' + String(e?.message ?? e), [], { rejected: 1 }, req.user?.id ?? 'anonymous');
  }
});
function saveMessage(db: ReturnType<typeof getDb>, id: string, sessionId: string, question: string, answer: string, citations: any[], meta: any, userId: string = 'admin') {
  const upsertSession = db.prepare(`UPDATE conversations SET updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`);
  upsertSession.run(sessionId);
  const ins = db.prepare(
    `INSERT INTO messages (id, session_id, user_id, role, question, content, citations, mode,
      tokens_in, tokens_out, latency_ms, first_token_ms, retrieve_ms,
      bm25_count, vector_count, fused_count, reranked_count, cited_count, rejected, hallucination)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  // 用户消息：只存问题
  // 2026-08-09 修复：mode 硬编码 'efficient' → 用 meta.mode（智能模式消息被存成高效，统计/历史全错）
  ins.run(id, sessionId, userId, 'user', question, question, null, meta.mode ?? 'efficient', null, null, null, null, null, null, null, null, null, null, 0, 0);
  // AI 回答：存答案 + 引用 + 指标
  const aiId = newId();
  ins.run(aiId, sessionId, userId, 'assistant', null, answer, JSON.stringify(citations), meta.mode ?? 'efficient',
    meta.tokensIn ?? null, meta.tokensOut ?? null, meta.latencyMs ?? null, meta.firstTokenMs ?? null, meta.retrieveMs ?? null,
    meta.raw?.bm25_top20?.length ?? null, meta.raw?.vector_top20?.length ?? null,
    meta.raw?.fused_top20?.length ?? null, meta.raw?.reranked?.length ?? null,
    meta.citedCount ?? null, meta.rejected ?? 0, meta.hallucination ?? 0);
  // 2026-08-09：引用计数预聚合（方案 a）——按天记账，统计引用排名直接查计数表（不再全量拉 citations JSON）
  if (meta.mode !== 'smart' && citations?.length) { // 高效模式 citations 结构化；智能模式 citations 是检索快照非实际引用，不计
    const d = new Date();
    const localDay = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); // 本地日期 YYYY-MM-DD
    const upsert = db.prepare(`INSERT INTO policy_citation_stats (day, line_id, source, count) VALUES (?,?,?,1)
      ON CONFLICT(day, line_id, source) DO UPDATE SET count = count + 1`);
    const seen = new Set<string>();
    for (const c of citations ?? []) {
      if (!c?.line_id || !c?.source) continue;
      const k = c.line_id + '|' + c.source;
      if (seen.has(k)) continue; // 同轮同政策去重（一次引用计一次）
      seen.add(k);
      upsert.run(localDay, c.line_id, c.source);
    }
  }
}

// GET /api/chat/:sessionId/history —— 取会话历史消息
chatRouter.get('/chat/:sessionId/history', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, role, question, content, citations, mode, tokens_in, tokens_out, latency_ms, first_token_ms, retrieve_ms,
       bm25_count, vector_count, fused_count, reranked_count, cited_count, rejected, created_at
     FROM messages WHERE session_id=? AND user_id=? ORDER BY created_at ASC`,
  ).all(req.params.sessionId, req.user?.id ?? 'anonymous') as any[];
  const messages = rows.map((r) => ({
    id: r.id, role: r.role, question: r.question, content: r.content, mode: r.mode,
    citations: r.citations ? JSON.parse(r.citations) : [],
    metrics: { tokens_in: r.tokens_in, tokens_out: r.tokens_out, latency_ms: r.latency_ms,
      first_token_ms: r.first_token_ms, retrieve_ms: r.retrieve_ms,
      bm25_count: r.bm25_count, vector_count: r.vector_count, fused_count: r.fused_count,
      reranked_count: r.reranked_count, cited_count: r.cited_count, rejected: r.rejected },
    created_at: r.created_at,
  }));
  res.json({ sessionId: req.params.sessionId, messages });
});