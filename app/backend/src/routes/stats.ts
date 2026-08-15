// 统计报表 API（S7，2026-08-09 v3，PRD §4.6）
// - 权限：requireFn('stats_view')；无权限 403
// - 以**会话数**为基础口径；不做模式过滤（对比而非单一模式）
// - 2026-08-09 v3 性能优化：
//   a) citations 改查 policy_citation_stats 预聚合表（saveMessage 按天记账）——不再全量拉 citations JSON 到内存 JS 聚合
//   b) 日期过滤改 UTC ISO 字符串范围比较（不包函数）→ 走 idx_messages_created 索引（原 datetime() 包列 = 全表扫描）
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { requireFn } from '../services/permission.js';

export const statsRouter = Router();
statsRouter.use(requireFn('stats_view'));

/** 本地日期（YYYY-MM-DD）→ UTC ISO 边界（isEnd=当日 23:59:59.999，否则 00:00:00.000） */
function localToUtc(dateStr: string, isEnd: boolean): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return isEnd ? new Date(y, m - 1, d, 23, 59, 59, 999).toISOString() : new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

/** 解析时间范围（本地日期 YYYY-MM-DD，默认 30 天）→ fromClause（{ts} 占位，调用处指定表前缀） */
function rangeOf(q: any): { from: string; to: string; fromClause: string } {
  const now = new Date();
  const localToday = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const to = q.to ? String(q.to).slice(0, 10) : localToday;
  const from = q.from ? String(q.from).slice(0, 10) : new Date(now.getTime() - 29 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  // UTC ISO 字符串范围比较（ISO 字典序 = 时间序，可直接走 created_at 索引；避免 datetime() 包列导致全表扫描）
  return { from, to, fromClause: `{ts} >= '${localToUtc(from, false)}' AND {ts} <= '${localToUtc(to, true)}'` };
}

/** 会话级聚合（按 mode）：会话数/平均轮次/平均耗时/平均输入/输出 token */
function sessionAgg(db: any, fromClause: string, groupByMode: boolean): any[] {
  const rows = db.prepare(`
    SELECT ${groupByMode ? 'mode AS mode,' : 'NULL AS mode,'}
      COUNT(DISTINCT session_id) AS sessions,
      COUNT(*) AS rounds,
      ROUND(AVG(latency_ms)) AS avg_latency_ms,
      ROUND(SUM(tokens_in) * 1.0 / COUNT(DISTINCT session_id)) AS avg_tokens_in,
      ROUND(SUM(tokens_out) * 1.0 / COUNT(DISTINCT session_id)) AS avg_tokens_out,
      SUM(tokens_in) AS tokens_in,
      SUM(tokens_out) AS tokens_out
    FROM messages WHERE role='assistant' AND ${fromClause.replaceAll('{ts}', 'created_at')}
    ${groupByMode ? 'GROUP BY mode' : ''}
  `).all() as any[];
  return rows;
}

// GET /api/stats/overview —— KPI 卡片 + 模式对比表（会话口径）
statsRouter.get('/overview', (req, res) => {
  const db = getDb();
  const { from, to, fromClause } = rangeOf(req.query);
  const agg = sessionAgg(db, fromClause, false)[0] ?? {};
  const sessions = agg.sessions ?? 0;
  const byMode = sessionAgg(db, fromClause, true);
  const smartRow = byMode.find((r) => r.mode === 'smart');
  const activeUsers = (db.prepare(`SELECT COUNT(DISTINCT user_id) c FROM messages WHERE role='assistant' AND ${fromClause.replaceAll('{ts}', 'created_at')}`).get() as any).c ?? 0;
  res.json({
    from, to,
    kpi: {
      sessions,
      avgRounds: sessions ? Math.round((agg.rounds ?? 0) / sessions * 100) / 100 : null,
      smartShare: sessions ? Math.round(((smartRow?.sessions ?? 0) / sessions) * 1000) / 10 : null,
      activeUsers,
      avgLatencyMs: agg.avg_latency_ms ?? null,
      tokensIn: agg.tokens_in ?? 0,
      tokensOut: agg.tokens_out ?? 0,
    },
    compare: [
      ...byMode.map((r) => ({
        mode: r.mode,
        sessions: r.sessions ?? 0,
        avgRounds: (r.sessions ?? 0) ? Math.round(((r.rounds ?? 0) / r.sessions) * 100) / 100 : null,
        avgLatencyMs: r.avg_latency_ms ?? null,
        avgTokensIn: r.avg_tokens_in ?? null,
        avgTokensOut: r.avg_tokens_out ?? null,
      })),
      { mode: 'all', sessions, avgRounds: sessions ? Math.round((agg.rounds ?? 0) / sessions * 100) / 100 : null, avgLatencyMs: agg.avg_latency_ms ?? null, avgTokensIn: agg.avg_tokens_in ?? null, avgTokensOut: agg.avg_tokens_out ?? null },
    ],
  });
});

// GET /api/stats/trends —— 会话数趋势（按天分模式）+ 会话小时分布（Top3 地区）+ 点赞点踩按天
statsRouter.get('/trends', (req, res) => {
  const db = getDb();
  const { from, to, fromClause } = rangeOf(req.query);
  const sessionTrend = db.prepare(`
    SELECT date(created_at,'localtime') AS day, mode, COUNT(DISTINCT session_id) AS sessions
    FROM messages WHERE role='assistant' AND ${fromClause.replaceAll('{ts}', 'created_at')}
    GROUP BY day, mode ORDER BY day
  `).all();
  const hourRows = db.prepare(`
    SELECT CAST(strftime('%H', datetime(m.created_at,'localtime')) AS INTEGER) AS hour, u.region AS region, COUNT(DISTINCT m.session_id) AS sessions
    FROM messages m LEFT JOIN users u ON u.id=m.user_id
    WHERE m.role='assistant' AND ${fromClause.replaceAll('{ts}', 'm.created_at')}
    GROUP BY hour, region ORDER BY hour, sessions DESC
  `).all() as { hour: number; region: string | null; sessions: number }[];
  const hourlyMap = new Map<number, { hour: number; total: number; topRegions: { region: string; sessions: number }[] }>();
  for (const r of hourRows) {
    const e = hourlyMap.get(r.hour) ?? { hour: r.hour, total: 0, topRegions: [] };
    e.total += r.sessions;
    if (e.topRegions.length < 3) e.topRegions.push({ region: r.region ?? '未知', sessions: r.sessions });
    hourlyMap.set(r.hour, e);
  }
  const hourly = [...hourlyMap.values()].sort((a, b) => a.hour - b.hour);
  const feedbackTrend = db.prepare(`
    SELECT date(created_at,'localtime') AS day, SUM(value='up') AS up, SUM(value='down') AS down
    FROM feedbacks WHERE ${fromClause.replaceAll('{ts}', 'created_at')}
    GROUP BY day ORDER BY day
  `).all();
  res.json({ from, to, sessionTrend, hourly, feedbackTrend });
});

// GET /api/stats/citations —— 引用政策库排名（全部库）+ 引用 TOP10 政策
// 2026-08-09 v3：查 policy_citation_stats 预聚合表（按天记账），不再全量拉 citations JSON
statsRouter.get('/citations', (req, res) => {
  const db = getDb();
  const { from, to } = rangeOf(req.query);
  // 政策排名（计数表 source 聚合）
  const topPolicies = db.prepare(`
    SELECT source AS name, SUM(count) AS count FROM policy_citation_stats
    WHERE day BETWEEN ? AND ? GROUP BY source ORDER BY count DESC LIMIT 10
  `).all(from, to);
  // 引用库排名：计数表按 line_id 聚合 → policy_lines 映射库 → 全部库（含 0）
  const lineStats = db.prepare(`
    SELECT line_id, SUM(count) AS count FROM policy_citation_stats
    WHERE day BETWEEN ? AND ? GROUP BY line_id
  `).all(from, to) as { line_id: string; count: number }[];
  const libs = db.prepare('SELECT id, name FROM policy_libraries ORDER BY name').all() as { id: string; name: string }[];
  const lines = db.prepare('SELECT id, library_id FROM policy_lines').all() as { id: string; library_id: string }[];
  const lineLib = new Map(lines.map((l) => [l.id, l.library_id]));
  const libCount = new Map<string, number>();
  for (const s of lineStats) {
    const lib = lineLib.get(s.line_id);
    if (lib) libCount.set(lib, (libCount.get(lib) ?? 0) + s.count);
  }
  const libraryRank = libs.map((l) => ({ library_id: l.id, name: l.name, count: libCount.get(l.id) ?? 0 })).sort((a, b) => b.count - a.count);
  res.json({ from, to, libraryRank, topPolicies });
});
