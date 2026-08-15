// 历史会话查看（WF-03.6）—— PRD §4.4.7
// - 超 24h 的会话：🔒 标记、顶部 ⚠ 提示、[重新提问]填 sessionStorage 跳首页不发送、输入框置灰
// - 未过期：可继续追问（本期简化：直接回首页新对话）
import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Typography, Alert, Space, Spin, Empty, Tag, Input, Collapse, App } from 'antd';
import { ArrowLeftOutlined, ReloadOutlined, SendOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, authFetch } from '../lib/api';
import { useSessionStore } from '../store/session';
import { rejectText } from '../lib/terms';
import { useTranslation } from 'react-i18next';
import TechDetail, { type Detail } from '../components/TechDetail';

interface HistMsg {
  id: string; role: 'user' | 'assistant'; question?: string; content: string;
  citations: { idx: number; line_id: string; source: string; section: string; anchor?: string }[];
  mode?: string; metrics: any; created_at: string;
  streaming?: boolean; // 2026-08-11：追问临时消息标记（空内容时显示"正在回答"，不误渲染为拒答）
}

export default function HistoryViewPage() {
  const { t } = useTranslation();
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [msgs, setMsgs] = useState<HistMsg[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [expired, setExpired] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [expireH, setExpireH] = useState(24);
  const [maxRounds, setMaxRounds] = useState(5); // 2026-08-11：历史页追问轮数上限（与首页一致）
  const [efficientEnabled, setEfficientEnabled] = useState(true); // 2026-08-11：高效模式开关（关闭后高效会话禁止追问）
  const load = async () => {
    setLoading(true);
    try {
      authFetch('/api/configs').then((r) => r.json()).then((d: any) => {
        const v = d.configs?.find((c: any) => c.key === 'common.session.expire_hours')?.value;
        if (v) setExpireH(Number(v));
        const mr = d.configs?.find((c: any) => c.key === 'efficient.generate.max_rounds')?.value;
        if (mr) setMaxRounds(Number(mr));
        const ee = d.configs?.find((c: any) => c.key === 'efficient.mode.enabled')?.value;
        if (ee != null) setEfficientEnabled(ee !== '0');
      }).catch(() => {});
      const [hist, sessList] = await Promise.all([api.get(`/chat/${sessionId}/history`), api.get('/sessions')]);
      setMsgs(hist.data.messages ?? []);
      const s = (sessList.data.sessions ?? []).find((x: any) => x.session_id === sessionId);
      setExpired(Boolean(s?.expired));
    } catch { setMsgs([]); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [sessionId]);

  const reAsk = () => {
    const first = msgs.find((m) => m.role === 'user')?.question ?? '';
    sessionStorage.setItem('policybot-prefill', first);
    // 2026-08-13 修复：开启新会话（生成新 sessionId 存 localStorage）——否则 HomePage 挂载用旧 sessionId 刷新恢复拉旧会话历史 → 进入最近一条历史会话
    useSessionStore.getState().newSession();
    navigate('/?new=1');
  };

  // 2026-08-11：历史页追问轮数限制与首页一致——追问继承会话模式（后端不传 mode 默认 efficient）；
  //   轮数口径与后端 429 一致（高效请求按会话全部 assistant 消息计）；派生计算，load 后自动更新（含追问追加的临时消息）
  const rounds = msgs.filter((m) => m.role === 'assistant').length;
  const sessionMode = [...msgs].reverse().find((m) => m.mode)?.mode ?? 'efficient';
  const roundsReached = sessionMode === 'efficient' && rounds >= maxRounds;
  // 2026-08-11：高效模式被管理员关闭且本会话是高效 → 禁止追问（不切智能），提示开启新对话
  const efficientBlocked = !efficientEnabled && sessionMode === 'efficient';

  const send = async () => {
    const q = input.trim();
    if (!q || sending || expired || roundsReached || efficientBlocked) return;
    setInput(''); setSending(true);
    const tmpAiId = crypto.randomUUID();
    setMsgs((m) => [...m, { id: crypto.randomUUID(), role: 'user', question: q, content: q, citations: [], metrics: {}, created_at: new Date().toISOString() } as HistMsg,
      { id: tmpAiId, role: 'assistant', question: '', content: '', citations: [], metrics: {}, created_at: '', streaming: true } as HistMsg]);
    try {
      const res = await authFetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Session-Id': sessionId! }, body: JSON.stringify({ question: q, mode: sessionMode }) });
      // 2026-08-11：429 轮数上限兑底（前端已拦截，多标签页并发等边缘场景）——明确提示，不再静默
      if (res.status === 429) {
        const err = await res.json().catch(() => ({}));
        message.warning(err?.error ?? t('home.roundsLimitShort'));
        await load();
        return;
      }
      if (!res.ok || !res.body) throw new Error('fail');
      const reader = res.body.getReader(); const dec = new TextDecoder('utf-8'); let buf = '', ct = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        for (const line of buf.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim(); if (d === '[DONE]') break;
          try { const ev = JSON.parse(d); if (ev.kind === 'delta') { ct += ev.text; setMsgs((m) => m.map((x) => x.id === tmpAiId ? { ...x, content: ct } : x)); } } catch {}
        }
        buf = buf.split('\n').pop() ?? '';
      }
    } catch { /* ignore, reload to get fresh state */ }
    setSending(false);
    await load();
  };

  if (loading) return <div style={{ padding: 24 }}><Spin /></div>;
  if (msgs.length === 0) return <div style={{ padding: 24 }}><Empty description={t('history.noMessages')} /></div>;

  return (
    <div style={{ padding: 24, maxWidth: 800, margin: '0 auto' }}>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>{t('history.back')}</Button>
        <Typography.Title level={4} style={{ margin: 0 }}>{t('history.title')}</Typography.Title>
      </Space>

      {expired && (
        <>
          <Alert type="warning" showIcon style={{ marginBottom: 12 }}
            message={t('history.expiredAlert', { hours: expireH })}
            action={<Button size="small" icon={<ReloadOutlined />} onClick={reAsk}>{t('history.reAsk')}</Button>} />
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
            {t('history.expiredHint')}
          </Typography.Text>
        </>
      )}

      {/* PRD §4.4.7：所有历史对话顶部 ⚠ 提示 */}
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message={t('history.policyUpdated')} />

      <div>
        {msgs.map((m) => (
          <div key={m.id} style={{ textAlign: m.role === 'user' ? 'right' : 'left', margin: '12px 0' }}>
            <div className={`bubble fixed ${m.role === 'user' ? 'user-bg user-right' : 'assistant-bg'}`}>
            <div className="bubble-role">
              {m.role === 'user' ? t('home.you') : t('home.aiRole', { mode: m.mode === 'smart' ? t('mode.smartFull') : t('mode.efficientFull') })}
            </div>
            <div className="bubble-content">
              {m.role === 'user' ? (m.question ?? m.content) : (
                m.content ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown> :
                m.streaming ? <span className="streaming-status">{t('home.answering')}<span className="cursor">▋</span></span> :
                <span style={{ color: '#878787' }}>{rejectText()}</span>
              )}
            </div>
            {m.role === 'assistant' && m.citations?.length > 0 && (
              <div className="citations">
                {m.citations.map((c, i) => (
                  // 2026-08-11：与首页一致——直接用后端返回的 anchor 拼接（原逆向工程 slug 可能跳错章节，ISSUE #5 同源教训）
                  <Tag key={i} color="blue" style={{ cursor: 'pointer' }}
                    onClick={() => { const u = c.line_id ? `/policy/${c.line_id}${c.anchor ? '#' + c.anchor : ''}` : null; if (u) window.open(u, '_blank'); }}>
                    {t('home.citationSimple', { source: c.source, section: c.section ?? '' })}
                  </Tag>
                ))}
              </div>
            )}
            {/* 2026-08-09：历史消息技术详情可展开（metrics 映射，缺失字段自动省略） */}
            {m.role === 'assistant' && (m.metrics && (m.metrics.latency_ms != null || m.metrics.tokens_in != null || m.metrics.retrieve_ms != null)) && (
              <div style={{ marginTop: 8 }}>
                <Collapse size="small" ghost items={[{
                  key: 'd', label: t('techDetail.title'),
                  children: <TechDetail mode={m.mode === 'smart' ? 'smart' : 'efficient'} rejected={Boolean(m.metrics?.rejected)}
                    detail={{
                      sessionId, // 2026-08-11 修复：历史页漏传 sessionId（URL 参数即有，与历史数据无关）→ 技术详情看不到 session
                      retrieveMs: m.metrics?.retrieve_ms ?? undefined,
                      latencyMs: m.metrics?.latency_ms ?? undefined,
                      tokensIn: m.metrics?.tokens_in ?? undefined,
                      tokensOut: m.metrics?.tokens_out ?? undefined,
                      firstTokenMs: m.metrics?.first_token_ms ?? undefined,
                      // 2026-08-11 修复：metrics 有计数但前端未传（显示不完全）
                      bm25Count: m.metrics?.bm25_count ?? undefined,
                      vectorCount: m.metrics?.vector_count ?? undefined,
                      fusedCount: m.metrics?.fused_count ?? undefined,
                      rerankedCount: m.metrics?.reranked_count ?? undefined,
                    } as Detail} />,
                }]} />
              </div>
            )}
          </div>
          </div>
        ))}
      </div>

      {/* PRD §4.4.7：过期输入框置灰；未过期可继续追问 */}
      <div style={{ marginTop: 20 }}>
        {expired ? (
          <div style={{ opacity: 0.6 }}>
            <input disabled placeholder={t('history.expiredInputPlaceholder')}
              style={{ width: '100%', padding: 10, border: '1px solid #d9d9d9', borderRadius: 8, background: '#f5f5f5' }} />
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} value={input} onChange={(e) => setInput(e.target.value)}
              placeholder={roundsReached ? t('home.roundsPlaceholder', { count: maxRounds }) : efficientBlocked ? t('home.efficientDisabled') : t('history.continueAsk')}
              disabled={sending || roundsReached || efficientBlocked}
              onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); send(); } }} />
            <Button type="primary" icon={<SendOutlined />} onClick={send} disabled={sending || !input.trim() || roundsReached || efficientBlocked}>{t('action.send')}</Button>
          </div>
        )}
      </div>
    </div>
  );
}