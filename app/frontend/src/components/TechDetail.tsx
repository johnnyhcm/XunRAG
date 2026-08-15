// 技术详情面板（共享组件：HomePage 实时问答 + HistoryViewPage 历史对话）
// 2026-08-09：从 HomePage 抽出复用——字段全可选，缺失自动省略
// （历史数据无 intent 分列/召回明细/sessionId/工具日志，实时数据齐全）
import { Button } from 'antd';
import { useTranslation } from 'react-i18next';

export interface Detail {
  retrieveMs?: number; latencyMs?: number; tokensIn?: number; tokensOut?: number;
  firstTokenMs?: number; intentTokensIn?: number; intentTokensOut?: number;
  bm25Count?: number; vectorCount?: number; fusedCount?: number; rerankedCount?: number;
  retrieved?: { rank: number; id: string; score: number; source?: string; section?: string }[];
  toolCalls?: number; toolCallLog?: { name: string; args: any }[];
  sessionId?: string;
  rejected?: boolean; // 2026-08-11：拒答/反问/转人工路径的 detail 标记（后端不发 reject 事件，前端从 detail 识别）
}

const fmtS = (ms: number | undefined | null): string => {
  if (ms == null) return '…';
  const s = ms / 1000;
  return s < 0.05 ? '<0.1s' : s.toFixed(1) + 's';
};

export default function TechDetail({ detail, rejected, mode }: { detail?: Detail; rejected?: boolean; mode?: string }) {
  const { t } = useTranslation();
  // session id 完整显示（含复制按钮——定位问题需完整 id 发给管理员）
  const SessionRow = () => (
    detail?.sessionId ? (
      <div style={{ fontSize: 11, color: '#aaa', display: 'flex', alignItems: 'center', gap: 6, wordBreak: 'break-all' }}>
        <span style={{ flex: 1, minWidth: 0 }}>session: {detail.sessionId}</span>
        <Button size="small" type="link" style={{ padding: 0, height: 'auto', fontSize: 11, flexShrink: 0 }}
          onClick={() => { navigator.clipboard?.writeText(detail.sessionId ?? ''); }}
          onMouseUp={(e) => e.stopPropagation()}>{t('techDetail.copy')}</Button>
      </div>
    ) : null
  );
  if (mode === 'smart') {
    return (
      <div className="tech-detail">
        <SessionRow />
        <div>{t('techDetail.fullAnswer', { time: detail?.latencyMs != null ? (detail.latencyMs / 1000).toFixed(1) + 's' : '…' })}{detail?.firstTokenMs != null && <> · {t('techDetail.firstToken', { time: ((detail.firstTokenMs) / 1000).toFixed(1) })}</>}</div>
        {detail?.tokensIn != null && <div>{t('techDetail.tokens', { in: detail.tokensIn.toLocaleString(), out: detail.tokensOut?.toLocaleString() ?? '' })}</div>}
        {detail?.toolCalls != null && (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontWeight: 600, fontSize: 12 }}>{t('techDetail.toolCalls', { count: detail.toolCalls })}</div>
            {(detail.toolCallLog ?? []).map((tc, i) => (
              <div key={i} style={{ fontSize: 12, padding: '2px 0', color: '#666' }}>
                {tc.name}
                {tc.args && Object.keys(tc.args).length
                  ? `（${Object.entries(tc.args).map(([k, v]) => `${k}: ${v}`).join('，')}）`
                  : ''}
              </div>
            ))}
          </div>
        )}
        {rejected && <div style={{ color: '#999' }}>{t('techDetail.rejectReason')}</div>}
      </div>
    );
  }
  return (
    <div className="tech-detail">
      <SessionRow />
      <div>{t('techDetail.retrieve', { time: fmtS(detail?.retrieveMs) })} · {t('techDetail.fullAnswer', { time: detail?.latencyMs != null ? (detail.latencyMs / 1000).toFixed(1) + 's' : '…' })}{detail?.firstTokenMs != null && <> · {t('techDetail.firstToken', { time: ((detail.firstTokenMs) / 1000).toFixed(1) })}</>}</div>
      {/* token 分列意图识别/生成（实时有分列；历史仅合计 → 无 intentTokens 时显示合计） */}
      {detail?.tokensIn != null && (
        <div>LLM token：{detail.intentTokensIn != null
          ? <>{t('techDetail.tokensIntent', { in: (detail.intentTokensIn).toLocaleString(), out: (detail.intentTokensOut ?? 0).toLocaleString() })}
            {(detail.tokensIn - detail.intentTokensIn) > 0 && <>；{t('techDetail.tokensGenerate', { in: (detail.tokensIn - detail.intentTokensIn).toLocaleString(), out: ((detail.tokensOut ?? 0) - (detail.intentTokensOut ?? 0)).toLocaleString() })}</>}</>
          : t('techDetail.tokens', { in: detail.tokensIn.toLocaleString(), out: detail.tokensOut?.toLocaleString() ?? '' })}
        </div>
      )}
      {rejected && <div style={{ color: '#999' }}>{t('techDetail.rejectReason')}</div>}
      {/* 2026-08-11 修复：补渲染检索计数（BM25/向量/融合/rerank 后），历史/实时均有数据 */}
      {(detail?.bm25Count != null || detail?.vectorCount != null || detail?.fusedCount != null || detail?.rerankedCount != null) && (
        <div style={{ fontSize: 12, color: '#666' }}>
          {t('techDetail.recall', { bm25: detail.bm25Count ?? '…', vector: detail.vectorCount ?? '…', fused: detail.fusedCount ?? '…', rerank: detail.rerankedCount ?? '…' })}
        </div>
      )}
      {detail?.retrieved && detail.retrieved.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontWeight: 600, fontSize: 12 }}>{t('techDetail.recallList')}</div>
          {detail.retrieved.map((r) => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
              <span style={{ color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>
                {r.source ? t('home.citationSimple', { source: r.source, section: r.section ? ' · ' + r.section : '' }) : r.id.slice(0, 18) + '…'}
              </span>
              <span style={{ color: '#1677ff', marginLeft: 8 }}>{r.score.toFixed(3)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
