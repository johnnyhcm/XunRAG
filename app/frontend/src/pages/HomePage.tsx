// AI 问答首页 —— S3 实装 + 引用可点击跳转制度章节
import { useEffect, useRef, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button, Input, Typography, Tag, Tooltip, Collapse, Space, App, Modal, Radio } from 'antd';
import { SendOutlined, LikeOutlined, DislikeOutlined, LinkOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../store/session';
import { useMyPerms } from '../lib/useMyPerms';
import { feedbackLabel } from '../lib/terms';
import TechDetail, { type Detail } from '../components/TechDetail';
import { authFetch } from '../lib/api';

interface Citation { idx: number; chunk_id: string; line_id: string; source: string; section: string; anchor: string }
interface Msg {
  id: string; role: 'user' | 'assistant'; question?: string; content: string;
  citations: Citation[]; detail?: Detail; rejected?: boolean; error?: string;
  feedback?: 'up' | 'down' | null; streaming?: boolean; mode?: 'efficient' | 'smart';
  contact?: { name: string; dept: string; contact: string; action_link?: string; topic?: string };
  action?: { link: string; text: string; name?: string };
  stage?: string;
}

// 从配置中心读取首页建议问题与阶段文案（2026-08-06，配置化）
// 2026-08-11：产品名/slogan/时段问候同样配置化（common.home.*）
// 2026-08-13：默认文案走 i18n（t），配置值优先级更高（配置中心 value_en 二期）
function useConfigTexts() {
  const { t } = useTranslation();
  const [suggestions, setSuggestions] = useState<string[]>(t('home.suggestions', { returnObjects: true }) as string[]);
  const [stageText, setStageText] = useState<Record<string, string>>({
    recognize: t('home.stage.recognize'),
    retrieve: t('home.stage.retrieve'),
    generate: t('home.stage.generate'),
    thinking: t('home.stage.thinking'),
    default: t('home.stage.default'),
  });
  const [feedbackReasons, setFeedbackReasons] = useState<string[]>(t('home.feedbackReasons', { returnObjects: true }) as string[]);
  const [maxRounds, setMaxRounds] = useState<number>(5); // 高效模式轮数上限（PRD §4.4.7，2026-08-09 前端置灰用）
  const [title, setTitle] = useState(t('app.title'));
  const [subtitle, setSubtitle] = useState(t('app.subtitle'));
  const [greetingEnabled, setGreetingEnabled] = useState(true);
  const [greetings, setGreetings] = useState({ morning: t('home.greetingMorning'), afternoon: t('home.greetingAfternoon'), evening: t('home.greetingEvening') });
  // 2026-08-11：高效模式开关（管理员可关闭；关闭后不显示高效入口，向量化照常）
  const [efficientEnabled, setEfficientEnabled] = useState(true);
  useEffect(() => {
    authFetch('/api/configs').then((r) => r.json()).then(({ configs }: any) => {
      const get = (k: string) => configs?.find((c: any) => c.key === k)?.value;
      const sug = get('common.home.suggestions');
      if (sug) { try { const arr = JSON.parse(sug); if (Array.isArray(arr) && arr.length) setSuggestions(arr.map(String)); } catch {} }
      const stage: Record<string, string> = {
        recognize: t('home.stage.recognize'), retrieve: t('home.stage.retrieve'),
        generate: t('home.stage.generate'), thinking: t('home.stage.thinking'), default: t('home.stage.default'),
      };
      for (const k of ['recognize', 'retrieve', 'generate', 'thinking', 'default']) {
        const v = get('common.ui.stage_' + k);
        if (v) stage[k] = v;
      }
      setStageText(stage);
      const reasons = get('common.feedback.reasons');
      if (reasons) { try { const arr = JSON.parse(reasons); if (Array.isArray(arr) && arr.length) setFeedbackReasons(arr.map(String)); } catch {} }
      const mr = get('efficient.generate.max_rounds');
      if (mr) { const n = Number(mr); if (Number.isFinite(n) && n > 0) setMaxRounds(n); }
      const t2 = get('common.home.title');
      if (t2) setTitle(t2);
      const st = get('common.home.subtitle');
      if (st) setSubtitle(st);
      const ge = get('common.home.greeting_enabled');
      if (ge != null) setGreetingEnabled(ge !== '0');
      setGreetings({
        morning: get('common.home.greeting_morning') || t('home.greetingMorning'),
        afternoon: get('common.home.greeting_afternoon') || t('home.greetingAfternoon'),
        evening: get('common.home.greeting_evening') || t('home.greetingEvening'),
      });
      const ee = get('efficient.mode.enabled');
      if (ee != null) setEfficientEnabled(ee !== '0');
    }).catch(() => { /* 配置不可用时用默认 */ });
  }, [t]);
  return { suggestions, stageText, feedbackReasons, maxRounds, title, subtitle, greetingEnabled, greetings, efficientEnabled };
}

export default function HomePage() {
  const { t } = useTranslation();
  const { suggestions, stageText: STAGE_TEXT, feedbackReasons, maxRounds, title, subtitle, greetingEnabled, greetings, efficientEnabled } = useConfigTexts();
  const effOff = !efficientEnabled; // 2026-08-11：高效模式被管理员关闭
  const perm = useMyPerms(); // 2026-08-11：问候语用当前用户姓名（与顶栏同源）
  const myName = perm?.user?.name;
  // 时段问候：5-11 早 / 12-17 下午 / 18-4 晚（按浏览器本地时区=用户时区）
  const greetingText = (() => {
    if (!greetingEnabled || !myName) return null;
    const h = new Date().getHours();
    const g = h >= 5 && h < 12 ? greetings.morning : h >= 12 && h < 18 ? greetings.afternoon : greetings.evening;
    return `${g}，${myName}`;
  })();
  const { message } = App.useApp();
  const ensureSession = useSessionStore((s) => s.ensure);
  const sessionId = ensureSession();

  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'efficient' | 'smart'>('efficient');
  const [sending, setSending] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false); // 刷新恢复：拉取当前会话历史完成前不渲染欢迎页
  // 2026-08-09：高效模式轮数上限置灰（PRD §4.4.7）——当前会话已有轮数 = assistant 消息数；智能模式不设限
  const [usedRounds, setUsedRounds] = useState(0);
  const roundsReached = mode === 'efficient' && usedRounds >= maxRounds;
  // 2026-08-11：高效模式关闭时——①模式强制智能；②当前会话若已是高效（进行到一半），禁止继续，提示开启新对话
  const sessionIsEfficient = msgs.some((m) => m.mode === 'efficient');
  const efficientBlocked = effOff && sessionIsEfficient;
  useEffect(() => { if (effOff && mode === 'efficient') setMode('smart'); }, [effOff, mode]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  useEffect(() => {
    const pre = sessionStorage.getItem('policybot-prefill');
    if (pre) { setInput(pre); sessionStorage.removeItem('policybot-prefill'); }
  }, []);

  // 刷新恢复（2026-08-07）：sessionId 已在 localStorage，挂载时拉历史消息，避免刷新后空白欢迎页
  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/chat/${sessionId}/history`).then((r) => r.json()).then((d: any) => {
      if (cancelled) return;
      const rows: any[] = d.messages ?? [];
      if (!rows.length) return;
      const hist: Msg[] = rows.map((r: any) => ({
        id: r.id,
        role: r.role,
        question: r.question,
        content: r.role === 'user' ? (r.question ?? r.content) : (r.content || ''),
        citations: Array.isArray(r.citations) ? r.citations : [],
        streaming: false,
        mode: r.mode === 'smart' ? 'smart' : 'efficient',
        rejected: Boolean(r.metrics?.rejected),
        // 2026-08-11 修复：刷新恢复也映射 detail（与 HistoryViewPage 一致）——此前刷新后历史消息无技术详情
        detail: r.metrics ? {
          sessionId,
          retrieveMs: r.metrics.retrieve_ms ?? undefined,
          latencyMs: r.metrics.latency_ms ?? undefined,
          tokensIn: r.metrics.tokens_in ?? undefined,
          tokensOut: r.metrics.tokens_out ?? undefined,
          firstTokenMs: r.metrics.first_token_ms ?? undefined,
          bm25Count: r.metrics.bm25_count ?? undefined,
          vectorCount: r.metrics.vector_count ?? undefined,
          fusedCount: r.metrics.fused_count ?? undefined,
          rerankedCount: r.metrics.reranked_count ?? undefined,
        } : undefined,
      }));
      setMsgs(hist);
      setUsedRounds(hist.filter((x) => x.role === 'assistant').length); // 2026-08-09：算当前会话轮数（置灰判断）
    }).catch(() => { /* 拉取失败按空会话处理，不影响提问 */ })
      .finally(() => { if (!cancelled) setHistoryLoaded(true); });
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (!userScrolledUp.current || atBottom) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [msgs]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    userScrolledUp.current = (el.scrollHeight - el.scrollTop - el.clientHeight >= 80);
  }, []);

  const send = useCallback(async (q: string) => {
    if (!q.trim() || sending) return;
    setInput(''); setSending(true); userScrolledUp.current = false;
    // 2026-08-11 修复：send 递增轮数（此前未递增 → roundsReached 恒 false，超限提示永不显示）；函数式更新不依赖闭包
    setUsedRounds((n) => n + 1);
    const userMsgId = crypto.randomUUID(), aiMsgId = crypto.randomUUID();
    setMsgs((m) => [...m, { id: userMsgId, role: 'user', content: q, citations: [], mode },
      { id: aiMsgId, role: 'assistant', content: '', citations: [], streaming: true, mode }]);
    const ctrl = new AbortController(); abortRef.current = ctrl;
    let ai: Msg = { id: aiMsgId, role: 'assistant', content: '', citations: [], streaming: true, mode };
    const patchAi = (p: Partial<Msg>) => { ai = { ...ai, ...p }; setMsgs((m) => m.map((x) => (x.id === aiMsgId ? ai : x))); };
    try {
      const res = await authFetch('/api/chat', { method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Session-Id': sessionId },
        body: JSON.stringify({ question: q, mode }), signal: ctrl.signal });
      if (!res.ok || !res.body) {
        // 2026-08-09：轮数上限拒绝（429）→ 明确提示开新对话；其他错误照旧
        if (res.status === 429) {
          const err = await res.json().catch(() => ({ error: t('home.roundsLimitShort') }));
          patchAi({ streaming: false, content: `⚠️ ${err?.error ?? t('home.roundsLimitShort')}` });
        } else {
          patchAi({ streaming: false, error: t('home.requestFailed', { status: res.status }) });
        }
        return;
      }
      const reader = res.body.getReader(); const dec = new TextDecoder('utf-8'); let buf = '', content = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue; const d = line.slice(5).trim();
          if (d === '[DONE]') { patchAi({ streaming: false }); return; }
          try { const ev = JSON.parse(d);
            if (ev.kind === 'citations') patchAi({ citations: ev.citations });
            else if (ev.kind === 'contact') patchAi({ contact: ev.contact });
            else if (ev.kind === 'action') patchAi({ action: ev.action });
            else if (ev.kind === 'status') patchAi({ stage: ev.stage });
            else if (ev.kind === 'detail') patchAi({ detail: ev });
            else if (ev.kind === 'reject') patchAi({ rejected: true, content: ev.message });
            else if (ev.kind === 'error') patchAi({ error: ev.message });
            else if (ev.kind === 'delta') { content += ev.text; patchAi({ content }); }
          } catch {}
        }
      }
      patchAi({ streaming: false });
    } catch (e: any) {
      patchAi({ streaming: false, content: e?.name === 'AbortError' ? ai.content + t('home.cancelled') : '', error: String(e?.message ?? e) });
    } finally { setSending(false); abortRef.current = null; }
  }, [sending, sessionId, mode]);

  const submitFeedback = async (msgId: string, value: 'up' | 'down', reason?: string) => {
    try {
      await authFetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Session-Id': sessionId }, body: JSON.stringify({ message_id: msgId, value, reason: reason ?? null }) });
      setMsgs((m) => m.map((x) => (x.id === msgId ? { ...x, feedback: value } : x)));
      message.success(value === 'up' ? t('home.feedbackUp') : t('home.feedbackDown'));
    } catch { message.error(t('home.feedbackFailed')); }
  };
  // 点踩 → 弹原因选择（PRD §4.4.5：可选原因，2026-08-06 补）
  const [downTarget, setDownTarget] = useState<{ msgId: string } | null>(null);
  const [downReason, setDownReason] = useState<string | null>(null);
  // 2026-08-11：补充说明（所有原因可选填，随 reason 一并提交落库/审计）
  const [downDetail, setDownDetail] = useState('');

  const openCitation = (c: Citation) => {
    const url = c.line_id ? `/policy/${c.line_id}${c.anchor ? '#' + c.anchor : ''}` : null;
    if (url) window.open(url, '_blank');
  };

  return (
    <div className="chat-home">
      {historyLoaded && msgs.length === 0 && (
        <div className="welcome-block">
          <Typography.Title level={2}>{title}</Typography.Title>
          <Typography.Text type="secondary">{subtitle}</Typography.Text>
          {greetingText && (
            <div style={{ marginTop: 8, fontSize: 13, color: '#888' }}>{greetingText}</div>
          )}
          <div className="welcome-composer">
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} value={input} onChange={(e) => setInput(e.target.value)}
              placeholder={t('home.inputPlaceholder')}
              onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); send(input); } }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
              <div className="mode-switch">
                {!effOff && <Tag color={mode === 'efficient' ? 'blue' : 'default'} style={{ cursor: 'pointer' }} onClick={() => setMode('efficient')}>{t('mode.efficientFull')}</Tag>}
                <Tag color={mode === 'smart' ? 'purple' : 'default'} style={{ cursor: 'pointer' }} onClick={() => setMode('smart')}>{t('mode.smartFull')}</Tag>
              </div>
              <Button type="primary" icon={<SendOutlined />} onClick={() => send(input)} disabled={sending || !input.trim()}>{t('action.send')}</Button>
            </div>
          </div>
          <div className="suggest-row">
            {suggestions.map((sg) => (<button key={sg} className="suggest-chip" onClick={() => send(sg)}>💬 {sg}</button>))}
          </div>
        </div>
      )}

      <div className="messages" ref={scrollRef} onWheel={onScroll}>
        {msgs.map((m) => (
          <div key={m.id} style={{ margin: '12px 0' }}>
            <div className={`bubble fixed ${m.role === 'user' ? 'user-bg user-right' : 'assistant-bg'}`}>
            <div className="bubble-role">{m.role === 'user' ? t('home.you') : t('home.aiRole', { mode: m.mode === 'smart' ? t('mode.smartFull') : t('mode.efficientFull') })}</div>
            <div className="bubble-content">
              {m.role === 'user' ? m.content :
                m.error ? <span style={{ color: '#cf1322' }}>⚠ {m.error}</span> :
                m.rejected ? <span style={{ color: '#878787' }}>{m.content}</span> :
                m.streaming && !m.content ? (
                  // 流式初始：无内容时只显示状态，避免窄条
                  <span className="streaming-status">
                    {m.stage ? STAGE_TEXT[m.stage] ?? STAGE_TEXT.default : STAGE_TEXT.default}
                    <span className="cursor">▋</span>
                  </span>
                ) : (
                  <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
                )}
              {m.role === 'assistant' && m.streaming && m.content && <span className="cursor">▋</span>}
            </div>
            {m.role === 'assistant' && m.citations.length > 0 && (
              <div className="citations">
                {m.citations.map((c) => (
                  <Tooltip key={c.idx} title={t('home.citationJump')}>
                    <Tag color="blue" style={{ cursor: 'pointer' }} onClick={() => openCitation(c)}>
                      <LinkOutlined /> {t('home.citation', { source: c.source || t('home.policyFallback'), section: c.section ? ' · ' + c.section : '', idx: c.idx })}
                    </Tag>
                  </Tooltip>
                ))}
              </div>
            )}
            {m.role === 'assistant' && m.contact && (
              <div className="contact-card">
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>👤 {m.contact.topic ? t('home.contactTitle', { topic: m.contact.topic }) : t('home.contactAssist')}</div>
                <div style={{ fontSize: 13 }}>{m.contact.name} · {m.contact.dept}</div>
                <div style={{ fontSize: 12, color: '#666' }}>{m.contact.contact}</div>
              </div>
            )}
            {m.role === 'assistant' && m.action && (
              <div className="action-card">
                <a href={m.action.link} target="_blank" rel="noreferrer" style={{ color: '#1677ff' }}>→ {m.action.text}{m.action.name ? `「${m.action.name}」` : ''}</a>
              </div>
            )}
            {m.role === 'assistant' && !m.streaming && !m.error && (
              <div className="msg-footer">
                <Space size={4}>
                  <Tooltip title={feedbackLabel('up')}><Button size="small" type="text" icon={<LikeOutlined />} className={m.feedback === 'up' ? 'fb-active' : ''} onClick={() => submitFeedback(m.id, 'up')} /></Tooltip>
                  <Tooltip title={feedbackLabel('down')}><Button size="small" type="text" icon={<DislikeOutlined />} className={m.feedback === 'down' ? 'fb-active' : ''} onClick={() => { setDownTarget({ msgId: m.id }); setDownReason(null); setDownDetail(''); }} /></Tooltip>
                </Space>
                {(m.detail || m.rejected) && <Collapse size="small" ghost items={[{ key: 'd', label: t('techDetail.title'), children: <TechDetail detail={m.detail} rejected={m.rejected ?? m.detail?.rejected} mode={m.mode ?? 'efficient'} /> }]} />}
              </div>
            )}
          </div>
          </div>
        ))}
      </div>

      {msgs.length > 0 && (
        <div className="composer">
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 5 }} value={input} onChange={(e) => setInput(e.target.value)}
            placeholder={roundsReached ? t('home.roundsPlaceholder', { count: maxRounds }) : efficientBlocked ? t('home.efficientDisabled') : t('input.placeholder')}
            disabled={roundsReached || efficientBlocked} onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); send(input); } }} />
          <div className="composer-foot">
            <Button type="primary" icon={<SendOutlined />} onClick={() => send(input)} disabled={sending || !input.trim() || roundsReached || efficientBlocked}>{t('action.send')}</Button>
          </div>
        </div>
      )}
      {/* 点踩原因选择（PRD §4.4.5，2026-08-06 补） */}
      <Modal open={!!downTarget} title={t('home.feedbackTitle')} onCancel={() => setDownTarget(null)}
        onOk={() => {
          if (downTarget && downReason) {
            const detail = downDetail.trim();
            submitFeedback(downTarget.msgId, 'down', detail ? `${downReason}：${detail}` : downReason);
            setDownTarget(null);
            setDownDetail('');
          }
        }}
        okText={t('action.submit')} cancelText={t('action.cancel')} okButtonProps={{ disabled: !downReason }} width={420}>
        <Radio.Group onChange={(e) => setDownReason(e.target.value)} value={downReason}
          style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 8 }}>
          {feedbackReasons.map((r) => <Radio key={r} value={r}>{r}</Radio>)}
        </Radio.Group>
        {downReason && (
          <Input.TextArea rows={2} maxLength={200} showCount placeholder={t('home.feedbackDetailPlaceholder')}
            value={downDetail} onChange={(e) => setDownDetail(e.target.value)} style={{ marginTop: 12 }} />
        )}
      </Modal>
    </div>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);