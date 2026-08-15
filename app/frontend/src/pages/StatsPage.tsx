// 统计报表页（S7 v2，2026-08-09，PRD §4.6）
// - 顶栏一级入口 /stats（权限 stats_view）
// - v2（用户定稿）：以会话数为口径；无模式过滤（对比而非单一模式）；单页 6 区块
// - 单位：Tokens=M（百万）、耗时=s；暂不做跳转原对话
// - 图表零依赖：CSS 横向条 + SVG 堆叠柱状/多线曲线
import { useEffect, useState } from 'react';
import { Card, Table, Segmented, DatePicker, Space, Typography, Empty, Tooltip } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { authFetch } from '../lib/api';
import { useTranslation } from 'react-i18next';

type Preset = 'today' | '7d' | '30d' | 'custom';

interface Kpi { sessions: number; avgRounds: number | null; smartShare: number | null; activeUsers: number; avgLatencyMs: number | null; tokensIn: number; tokensOut: number }
interface CompareRow { mode: string; sessions: number; avgRounds: number | null; avgLatencyMs: number | null; avgTokensIn: number | null; avgTokensOut: number | null }
interface Overview { from: string; to: string; kpi: Kpi; compare: CompareRow[] }
interface Trends { from: string; to: string; sessionTrend: { day: string; mode: string; sessions: number }[]; hourly: { hour: number; total: number; topRegions: { region: string; sessions: number }[] }[]; feedbackTrend: { day: string; up: number; down: number }[] }
interface Citations { from: string; to: string; libraryRank: { library_id: string; name: string; count: number }[]; topPolicies: { name: string; count: number }[] }

const MODE_LABEL: Record<string, string> = {}; // 实际值走 i18n（stats.legendEfficient/Smart/all）
const MODE_COLOR: Record<string, string> = { efficient: '#1677ff', smart: '#722ed1' };
const fmtTok = (n: number) => `${(n / 1e6).toFixed(2)}M`;
const fmtSec = (ms: number | null) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);

/** CSS 横向条形（value 可含 0；label 完整显示，容器可滚动） */
function HBars({ items, color = '#1677ff', labelWidth = 200, scrollable = false }: {
  items: { label: string; value: number; extra?: string }[]; color?: string; labelWidth?: number; scrollable?: boolean;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const body = (
    <div style={{ maxHeight: 300, overflowY: 'auto', paddingRight: 4 }}>
      {items.map((i) => (
        <div key={i.label} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0', fontSize: 12 }}>
          <span style={{ width: labelWidth, textAlign: 'right', color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }} title={i.label}>{i.label}</span>
          <div style={{ flex: 1, background: '#f0f0f0', borderRadius: 3, height: 14, minWidth: 60 }}>
            <div style={{ width: `${(i.value / max) * 100}%`, background: color, borderRadius: 3, height: 14, minWidth: i.value ? 3 : 0 }} />
          </div>
          {/* 2026-08-09：数字标签加粗加宽，保证清晰可见 */}
          <span style={{ width: 90, color: '#333', fontWeight: 600, flexShrink: 0 }}>{i.value}{i.extra ?? ''}</span>
        </div>
      ))}
    </div>
  );
  return scrollable ? <div style={{ overflowX: 'auto' }}>{body}</div> : body;
}

/** SVG 堆叠柱状图（按天：高效 + 智能叠加；hover 显示模式会话数与占比） */
function StackedBars({ data }: { data: { day: string; efficient: number; smart: number }[] }) {
  const { t } = useTranslation();
  if (!data.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('stats.noData')} />;
  const W = 720, H = 200, P = 30;
  const max = Math.max(1, ...data.map((d) => d.efficient + d.smart)) * 1.15;
  const bw = Math.min(40, (W - P * 2) / data.length * 0.6);
  const x = (i: number) => P + (i * (W - P * 2)) / data.length;
  const y = (v: number) => H - P - (v / max) * (H - P * 2);
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: W, overflowX: 'auto' }}>
      {data.map((d, i) => {
        const cx = x(i) + (W - P * 2) / data.length / 2 - bw / 2;
        const effH = (d.efficient / max) * (H - P * 2);
        const smartH = (d.smart / max) * (H - P * 2);
        const share = d.efficient + d.smart ? Math.round((d.smart / (d.efficient + d.smart)) * 100) : 0;
        return (
          <g key={d.day}>
            <rect x={cx} y={y(d.efficient + d.smart)} width={bw} height={effH + smartH} fill="#1677ff">
              <title>{t('stats.stackTitle', { day: d.day, efficient: d.efficient, smart: d.smart, share })}</title>
            </rect>
            <rect x={cx} y={y(d.smart)} width={bw} height={smartH} fill="#722ed1">
              <title>{t('stats.stackTitle', { day: d.day, efficient: d.efficient, smart: d.smart, share })}</title>
            </rect>
            {/* 2026-08-09：柱顶数字标签（总会话数），柱内分段标签（高效/智能各数，段高足够时显示） */}
            <text x={cx + bw / 2} y={y(d.efficient + d.smart) - 4} textAnchor="middle" fontSize={10} fontWeight={600} fill="#333">{d.efficient + d.smart}</text>
            {effH > 18 && <text x={cx + bw / 2} y={y(d.efficient + d.smart) + effH / 2 + 3} textAnchor="middle" fontSize={9} fill="#fff">{d.efficient}</text>}
            {smartH > 18 && d.smart > 0 && <text x={cx + bw / 2} y={y(d.smart) + smartH / 2 + 3} textAnchor="middle" fontSize={9} fill="#fff">{d.smart}</text>}
            <text x={cx + bw / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="#999">{d.day.slice(5)}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** SVG 曲线图（多系列；hover 原生 title 显示明细） */
function Curve({ points, xLabel, height = 160 }: {
  points: { key: string; label: string; value: number; detail: string }[]; xLabel: string; height?: number;
}) {
  const { t } = useTranslation();
  if (!points.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('stats.noData')} />;
  const W = 720, H = height, P = 28;
  const max = Math.max(1, ...points.map((p) => p.value)) * 1.15;
  const x = (i: number) => P + (i * (W - P * 2)) / Math.max(1, points.length - 1);
  const y = (v: number) => H - P - (v / max) * (H - P * 2);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: W }}>
      {/* 2026-08-09 修复：polyline 的 points 不支持 M/L 命令，需 <path d>（原导致曲线不渲染只剩散点） */}
      <path d={path} fill="none" stroke="#1677ff" strokeWidth={2} />
      {points.map((p, i) => (
        <g key={p.key}>
          <circle cx={x(i)} cy={y(p.value)} r={3} fill="#1677ff">
            <title>{p.detail}</title>
          </circle>
          {/* 2026-08-09：曲线数据点数字标签（>0 显示，避免 0 值拥挤） */}
          {p.value > 0 && <text x={x(i)} y={y(p.value) - 6} textAnchor="middle" fontSize={9} fontWeight={600} fill="#333">{p.value}</text>}
          {points.length <= 32 && <text x={x(i)} y={H - 6} textAnchor="middle" fontSize={9} fill="#999">{p.label}</text>}
        </g>
      ))}
    </svg>
  );
}

export default function StatsPage() {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<Preset>('30d');
  const [customRange, setCustomRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [range, setRange] = useState<{ from: string; to: string }>(() => {
    const to = dayjs().format('YYYY-MM-DD');
    return { from: dayjs().subtract(29, 'day').format('YYYY-MM-DD'), to };
  });
  const [ov, setOv] = useState<Overview | null>(null);
  const [tr, setTr] = useState<Trends | null>(null);
  const [ct, setCt] = useState<Citations | null>(null);

  const applyRange = (p: Preset) => {
    const to = dayjs().format('YYYY-MM-DD');
    if (p === 'today') setRange({ from: to, to });
    else if (p === '7d') setRange({ from: dayjs().subtract(6, 'day').format('YYYY-MM-DD'), to });
    else if (p === '30d') setRange({ from: dayjs().subtract(29, 'day').format('YYYY-MM-DD'), to });
    setPreset(p);
  };

  useEffect(() => {
    const q = `?from=${range.from}&to=${range.to}`;
    Promise.all([
      authFetch(`/api/stats/overview${q}`).then((r) => r.json()),
      authFetch(`/api/stats/trends${q}`).then((r) => r.json()),
      authFetch(`/api/stats/citations${q}`).then((r) => r.json()),
    ]).then(([o, t, c]) => { setOv(o); setTr(t); setCt(c); })
      .catch(() => { setOv(null); setTr(null); setCt(null); });
  }, [range]);

  const k = ov?.kpi;
  const KPI = [
    { label: t('stats.kpi.sessions'), value: k?.sessions ?? '—' },
    { label: t('stats.kpi.avgRounds'), value: k?.avgRounds != null ? k.avgRounds.toFixed(1) : '—' },
    { label: t('stats.kpi.smartShare'), value: k?.smartShare != null ? `${k.smartShare}%` : '—' },
    { label: t('stats.kpi.activeUsers'), value: k?.activeUsers ?? '—' },
    { label: t('stats.kpi.avgLatency'), value: fmtSec(k?.avgLatencyMs ?? null) },
    { label: t('stats.kpi.tokensIn'), value: k ? fmtTok(k.tokensIn) : '—' },
    { label: t('stats.kpi.tokensOut'), value: k ? fmtTok(k.tokensOut) : '—' },
  ];
  const modeLabel = (v: string) => v === 'all' ? t('stats.all') : v === 'efficient' ? t('stats.legendEfficient') : v === 'smart' ? t('stats.legendSmart') : v;

  // 会话数趋势（堆叠）：聚合按天 × 模式
  const trendMap = new Map<string, { day: string; efficient: number; smart: number }>();
  for (const r of tr?.sessionTrend ?? []) {
    const e = trendMap.get(r.day) ?? { day: r.day, efficient: 0, smart: 0 };
    if (r.mode === 'smart') e.smart = r.sessions; else e.efficient = r.sessions;
    trendMap.set(r.day, e);
  }
  const stackedData = [...trendMap.values()];

  // 小时分布曲线
  const hourlyPoints = (tr?.hourly ?? []).map((h) => ({
    key: String(h.hour),
    label: `${h.hour}:00`,
    value: h.total,
    detail: `${t('stats.hourlyDetail', { hour: h.hour, total: h.total })}\n${h.topRegions.map((r) => t('stats.regionDetail', { region: r.region, sessions: r.sessions })).join('\n')}`,
  }));

  // 点赞/点踩双线
  const fbUp = (tr?.feedbackTrend ?? []).map((d) => ({ key: d.day, label: d.day.slice(5), value: d.up ?? 0, detail: t('stats.fbUpDetail', { day: d.day, up: d.up ?? 0 }) }));
  const fbDown = (tr?.feedbackTrend ?? []).map((d) => ({ key: d.day, label: d.day.slice(5), value: d.down ?? 0, detail: t('stats.fbDownDetail', { day: d.day, down: d.down ?? 0 }) }));

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 4 }}>{t('stats.title')}</h2>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('stats.range', { from: range.from, to: range.to })}</Typography.Text>
      <Space wrap style={{ margin: '12px 0 16px' }}>
        <Segmented value={preset} options={[
          { label: t('stats.today'), value: 'today' }, { label: t('stats.days7'), value: '7d' }, { label: t('stats.days30'), value: '30d' }, { label: t('stats.custom'), value: 'custom' },
        ]} onChange={(v) => applyRange(v as Preset)} />
        {preset === 'custom' && (
          <DatePicker.RangePicker value={customRange} onChange={(v) => {
            if (v && v[0] && v[1]) { setCustomRange([v[0], v[1]]); setRange({ from: v[0].format('YYYY-MM-DD'), to: v[1].format('YYYY-MM-DD') }); }
          }} />
        )}
      </Space>

      {/* KPI 卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
        {KPI.map((item) => (
          <Card key={item.label} size="small" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 600, color: '#1677ff' }}>{item.value}</div>
            <div style={{ fontSize: 12, color: '#888' }}>{item.label}</div>
          </Card>
        ))}
      </div>

      {/* ① 模式对比 */}
      <Card size="small" title={t('stats.modeCompare')} style={{ marginBottom: 12 }}>
        <Table size="small" rowKey="mode" dataSource={ov?.compare ?? []} pagination={false}
          columns={[
            { title: t('stats.col.mode'), dataIndex: 'mode', width: 100, render: (v: string) => (v === 'all' ? <b>{t('stats.all')}</b> : <span style={{ color: MODE_COLOR[v] ?? '#333' }}>{modeLabel(v)}</span>) },
            { title: t('stats.col.sessions'), dataIndex: 'sessions', width: 100 },
            { title: t('stats.col.avgRounds'), dataIndex: 'avgRounds', width: 110, render: (v: number | null) => v == null ? '—' : v.toFixed(1) },
            { title: (
              <Tooltip title={t('stats.avgLatencyTip')}>{t('stats.col.avgLatency')}</Tooltip>
            ), dataIndex: 'avgLatencyMs', width: 100, render: (v: number | null) => fmtSec(v) },
            { title: t('stats.col.avgTokensIn'), dataIndex: 'avgTokensIn', width: 140, render: (v: number | null) => v == null ? '—' : v.toLocaleString() },
            { title: t('stats.col.avgTokensOut'), dataIndex: 'avgTokensOut', width: 140, render: (v: number | null) => v == null ? '—' : v.toLocaleString() },
          ]} />
      </Card>

      {/* ② 会话数变化趋势（堆叠柱状） */}
      <Card size="small" title={t('stats.trendTitle')} style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#888', marginBottom: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 14, height: 10, background: '#1677ff', display: 'inline-block' }} />{t('stats.legendEfficient')}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 14, height: 10, background: '#722ed1', display: 'inline-block' }} />{t('stats.legendSmart')}</span>
        </div>
        <StackedBars data={stackedData} />
      </Card>

      {/* ③ 会话小时分布 + ④ 点赞点踩（两列） */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <Card size="small" title={t('stats.hourlyTitle')}>
          <Curve points={hourlyPoints} xLabel={t('stats.hourAxis')} />
        </Card>
        <Card size="small" title={t('stats.feedbackTitle')}>
          {fbUp.length > 0 ? (
            <svg width="100%" viewBox="0 0 720 160" style={{ maxWidth: 720 }}>
              {(() => {
                const all = [...fbUp, ...fbDown];
                const max = Math.max(1, ...all.map((p) => p.value)) * 1.15;
                const x = (i: number) => 28 + (i * (720 - 56)) / Math.max(1, fbUp.length - 1);
                const y = (v: number) => 160 - 28 - (v / max) * (160 - 56);
                const line = (pts: typeof fbUp, color: string) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
                return (<>
                  {/* 2026-08-09 修复：polyline → path（points 不支持 M/L） */}
                  <path d={line(fbUp, '#1677ff')} fill="none" stroke="#1677ff" strokeWidth={2} />
                  <path d={line(fbDown, '#ff4d4f')} fill="none" stroke="#ff4d4f" strokeWidth={2} />
                  {fbUp.map((p, i) => (<g key={p.key}>
                    <circle cx={x(i)} cy={y(p.value)} r={3} fill="#1677ff"><title>{p.detail}</title></circle>
                    <circle cx={x(i)} cy={y(fbDown[i]?.value ?? 0)} r={3} fill="#ff4d4f"><title>{fbDown[i]?.detail}</title></circle>
                    {/* 2026-08-09：点赞/点踩数据点数字标签（>0 显示） */}
                    {p.value > 0 && <text x={x(i)} y={y(p.value) - 6} textAnchor="middle" fontSize={9} fontWeight={600} fill="#1677ff">{p.value}</text>}
                    {(fbDown[i]?.value ?? 0) > 0 && <text x={x(i)} y={y(fbDown[i]?.value ?? 0) - 6} textAnchor="middle" fontSize={9} fontWeight={600} fill="#ff4d4f">{fbDown[i]?.value}</text>}
                    <text x={x(i)} y={160 - 6} textAnchor="middle" fontSize={9} fill="#999">{p.label}</text>
                  </g>))}
                </>);
              })()}
            </svg>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('stats.noFeedback')} />
          )}
          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#888', marginTop: 4 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 14, height: 3, background: '#1677ff', display: 'inline-block' }} />{t('stats.legendUp')}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 14, height: 3, background: '#ff4d4f', display: 'inline-block' }} />{t('stats.legendDown')}</span>
          </div>
        </Card>
      </div>

      {/* ⑤ 引用政策库排名（全部库，横向滚动） */}
      <Card size="small" title={t('stats.libRankTitle')} style={{ marginBottom: 12 }}>
        {ct?.libraryRank.length ? <HBars items={ct.libraryRank.map((l) => ({ label: l.name, value: l.count }))} color="#1677ff" scrollable /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('stats.noData')} />}
      </Card>

      {/* ⑥ 引用 TOP10 政策（完整名） */}
      <Card size="small" title={t('stats.top10Title')}>
        {ct?.topPolicies.length ? <HBars items={ct.topPolicies.map((p) => ({ label: p.name, value: p.count }))} color="#722ed1" labelWidth={260} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('stats.noData')} />}
      </Card>
    </div>
  );
}
