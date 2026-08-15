// 历史对话侧边栏（WF-04 + WF-03.6，PRD §4.4.7）
// 使用原生 aside + CSS（退出 AntD Drawer），确保渲染可靠
import { useEffect, useState, useCallback } from 'react';
import { Empty, Spin, Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../store/session';
import { api } from '../lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenHistory: (sessionId: string) => void;
}

interface SessionRow {
  session_id: string;
  first_question: string;
  last_at: string;
  message_count: number;
  expired: 0 | 1;
}

function formatTime(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts.includes('Z') ? ts : ts.replace(' ', 'T') + 'Z');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export default function HistorySidebar({ open, onClose, onOpenHistory }: Props) {
  const { t } = useTranslation();
  const mySession = useSessionStore((s) => s.sessionId);
  const userId = useSessionStore((s) => s.userId); // 切换用户 → 历史按用户刷新（2026-08-07）
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/sessions'); // 后端读 X-User-Id header 过滤，axios 拦截器自动带
      setRows(res.data.sessions ?? []);
    } catch (e) { console.error('[history]', e); setRows([]); } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (open) load(); }, [open, load, userId]);

  // 分组：今天 / 昨天 / 更早
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday0 = today0 - 86400000;
  const today: SessionRow[] = [];
  const yesterday: SessionRow[] = [];
  const earlier: SessionRow[] = [];
  for (const r of rows) {
    const raw = (r.last_at || '');
    // 兼容旧格式（无Z）和新格式（含Z）：统一按UTC解析
    const ts = new Date(raw.includes('Z') ? raw : raw.replace(' ', 'T') + 'Z').getTime();
    if (!ts || isNaN(ts)) { earlier.push(r); continue; }
    if (ts >= today0) today.push(r);
    else if (ts >= yesterday0) yesterday.push(r);
    else earlier.push(r);
  }

  return (
    <>
      <div className={`backdrop ${open ? 'show' : ''}`} onClick={onClose} />
      <aside className={`sidebar-left ${open ? 'open' : ''}`}>
        <div className="sidebar-head">
          <span>{t('history.title')}</span>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        {loading && <div style={{ textAlign: 'center', padding: 20 }}><Spin /></div>}
        {!loading && rows.length === 0 && <Empty description={t('history.empty')} style={{ marginTop: 20 }} />}

        {today.length > 0 && (
          <div className="history-group">
            <div className="group-label">{t('history.today')}</div>
            {today.map((r) => (
              <button key={r.session_id} className={`history-item${r.session_id === mySession ? ' cur' : ''}`}
                onClick={() => { onClose(); onOpenHistory(r.session_id); }}>
                <span className="hi-text">{r.expired ? <Tooltip title={t('history.expired')}>🔒</Tooltip> : ''}{r.first_question || t('history.emptyTitle')}</span>
                <span className="hi-time">{formatTime(r.last_at)}</span>
              </button>
            ))}
          </div>
        )}
        {yesterday.length > 0 && (
          <div className="history-group">
            <div className="group-label">{t('history.yesterday')}</div>
            {yesterday.map((r) => (
              <button key={r.session_id} className="history-item" onClick={() => { onClose(); onOpenHistory(r.session_id); }}>
                <span className="hi-text">{r.expired ? <Tooltip title={t('history.expired')}>🔒</Tooltip> : ''}{r.first_question || t('history.emptyTitle')}</span>
                <span className="hi-time">{formatTime(r.last_at)}</span>
              </button>
            ))}
          </div>
        )}
        {earlier.length > 0 && (
          <div className="history-group">
            <div className="group-label">{t('history.earlier')}</div>
            {earlier.map((r) => (
              <button key={r.session_id} className="history-item" onClick={() => { onClose(); onOpenHistory(r.session_id); }}>
                <span className="hi-text">{r.expired ? <Tooltip title={t('history.expired')}>🔒</Tooltip> : ''}{r.first_question || t('history.emptyTitle')}</span>
                <span className="hi-time">{formatTime(r.last_at)}</span>
              </button>
            ))}
          </div>
        )}
      </aside>
    </>
  );
}