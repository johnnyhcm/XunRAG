// 员工端政策浏览/搜索/全文阅读（PRD §4.3）
// - 浏览：按政策库列已发布且日期命中今天的政策
// - 搜索：标题 + 正文关键词匹配（基于原文 markdown）
// - 阅读：Word→HTML 渲染（无下载入口），章节锚点树
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { getEffectiveVersion, getEffectiveVersionIds, parseAnchors, getReferences } from '../db/repo.js';
import { getVisibleLineIds } from '../services/permission.js';
import { getLevelPolicy, getSecurityLevels, localizeLevels } from '../services/security.js';
import { getConfig } from '../services/config.js';
import { logger } from '../services/logger.js';
import { versionStatus } from '../services/timezone.js';
import { E, sendErr } from '../services/errors.js';

export const browseRouter = Router();

/** 当前生效版本 id 集合 + S6 可见 line 集合（权限：无权政策不显示，防探测） */
function effectiveIdsClause(user: any): { sql: string; args: string[] } {
  const ids = getEffectiveVersionIds();
  const visible = getVisibleLineIds(user ?? null);
  if (!ids.length || !visible.length) return { sql: '1=0', args: [] };
  return {
    sql: `v.id IN (${ids.map(() => '?').join(',')}) AND pl.id IN (${visible.map(() => '?').join(',')})`,
    args: [...ids, ...visible],
  };
}

// 按库浏览（含筛选：topic/policy_type/publish_org；library_id 可选）
browseRouter.get('/browse', (req, res) => {
  const db = getDb();
  const where: string[] = [];
  const args: any[] = [];
  if (req.query.library_id) { where.push('pl.library_id=?'); args.push(req.query.library_id); }
  if (req.query.topic) { where.push('pl.topic=?'); args.push(req.query.topic); }
  if (req.query.policy_type) { where.push('pl.policy_type=?'); args.push(req.query.policy_type); }
  if (req.query.publish_org) { where.push('pl.publish_org=?'); args.push(req.query.publish_org); }
  const wsql = where.length ? `AND ${where.join(' AND ')}` : '';
  const eff = effectiveIdsClause(req.user);
  const real = db.prepare(
    `SELECT pl.id AS line_id, pl.name, pl.policy_type, pl.topic, pl.publish_org,
       l.id AS library_id, l.name AS library_name,
       v.id AS version_id, v.version_no, v.effective_from, v.effective_to, v.language
     FROM policy_lines pl
     JOIN policy_libraries l ON pl.library_id=l.id
     JOIN policy_versions v ON v.line_id=pl.id
     WHERE ${eff.sql} ${wsql}
     ORDER BY l.name, pl.name`,
  ).all(...eff.args, ...args) as any[];
  res.json({ policies: real });
});

// 关键词搜索（标题 + 正文）
browseRouter.get('/search', (req, res) => {
  const q = (String(req.query.q ?? '')).trim();
  if (!q) return res.json({ results: [] });
  const db = getDb();
  const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
  const eff = effectiveIdsClause(req.user);
  const rows = db.prepare(
    `SELECT pl.id AS line_id, pl.name, pl.policy_type, pl.publish_org,
       l.id AS library_id, l.name AS library_name,
       v.id AS version_id, v.version_no, v.effective_from
     FROM policy_lines pl
     JOIN policy_libraries l ON pl.library_id=l.id
     JOIN policy_versions v ON v.line_id=pl.id
     WHERE ${eff.sql}
       AND (pl.name LIKE ? ESCAPE '\\' OR v.markdown_content LIKE ? ESCAPE '\\')
     ORDER BY pl.name LIMIT 50`,
  ).all(...eff.args, like, like) as any[];
  res.json({ results: rows, query: q });
});

// 全文阅读：当前有效版本（政策线级 URL /policy/{id}）
browseRouter.get('/policy/:lineId', (req, res) => {
  // S6 权限：无权政策明确提示"无权限"（区别于不存在的 404）
  // 2026-08-07 修复：匿名（无身份）或可见集合不含该 line → 403（原 `visible.length &&` 在 visible 空数组时放行——
  //   停用/伪造身份用户可 URL 直连阅读任意政策，ISSUE #36 同根因另一入口）
  const visible = getVisibleLineIds(req.user ?? null);
  if (!req.user || !visible.includes(req.params.lineId)) {
    // 越权审计（2026-08-12，密级策略 audit_denied）——安全审计核心：谁试图越权
    denyAudit(req, req.params.lineId);
    return sendErr(req, res, 403, E('PERM_POLICY', '无权限访问该政策', 'No permission to access this policy'));
  }
  const v = getEffectiveVersion(req.params.lineId);
  if (!v) return sendErr(req, res, 404, E('POLICY_NO_READABLE_VERSION', '无可阅读的有效版本', 'No readable effective version'));
  serveRead(req, req.params.lineId, v, res);
});

// 版本级 URL /policy/{id}/{versionId}（已发布/已废止均可浏览；员工端列表仅显示生效版本）
browseRouter.get('/policy/:lineId/:versionId', (req, res) => {
  // S6 权限：无权政策明确提示"无权限"（同 /policy/:lineId 修复：匿名/不在可见集合 → 403）
  const visible = getVisibleLineIds(req.user ?? null);
  if (!req.user || !visible.includes(req.params.lineId)) {
    denyAudit(req, req.params.lineId);
    return sendErr(req, res, 403, E('PERM_POLICY', '无权限访问该政策', 'No permission to access this policy'));
  }
  const db = getDb();
  const v: any = db.prepare('SELECT * FROM policy_versions WHERE id=?').get(req.params.versionId);
  if (!v || v.line_id !== req.params.lineId || !['published', 'invalid'].includes(v.status)) {
    return sendErr(req, res, 404, E('POLICY_VERSION_NOT_PUBLISHED', '版本不存在或未发布', 'Version not found or not published'));
  }
  serveRead(req, req.params.lineId, v, res);
});

/** 越权尝试审计（2026-08-12）：政策存在但用户无权限（403）→ **无条件记录**——越权尝试本身是安全事件，与目标密级无关
 *  （原按密级策略 audit_denied 过滤 → public 政策越权不记，是误设计；正常浏览 audit_read 仍按密级过滤——浏览量大，越权量小且全是安全信号） */
function denyAudit(req: any, lineId: string) {
  try {
    const line = getDb().prepare('SELECT name, security_level FROM policy_lines WHERE id=?').get(lineId) as { name: string; security_level: string | null } | undefined;
    if (!line) return; // 政策不存在不记（避免噪音）
    logger.audit({ action: 'read_policy_denied', userId: req.user?.id ?? null, userName: req.user?.name ?? null, employeeNo: req.user?.employee_no ?? null, lineId, lineName: line.name, security_level: line.security_level ?? null, sessionId: req.sessionId });
  } catch { /* 审计失败不阻塞 */ }
}

function serveRead(req: any, lineId: string, v: any, res: any) {
  // 2026-08-13 多时区：版本状态按政策线时区绝对时刻判（原服务器本地时区）
  const db = getDb();
  const line: any = db.prepare('SELECT * FROM policy_lines WHERE id=?').get(lineId);
  const computed_status = v.status === 'invalid' ? 'invalid'
    : v.status === 'draft' ? 'draft'
    : versionStatus(v.effective_from, v.effective_to, line?.timezone ?? null);
  // 浏览审计（2026-08-12，密级策略 audit_read）：谁读过什么政策（含密级/版本；冗余存姓名/工号——日志自包含，用户改名/删除仍可追溯）
  try {
    if (getLevelPolicy(line?.security_level).audit_read) {
      logger.audit({ action: 'read_policy', userId: req.user?.id ?? null, userName: req.user?.name ?? null, employeeNo: req.user?.employee_no ?? null, lineId, lineName: line?.name ?? null, security_level: line?.security_level ?? null, versionId: v.id, sessionId: req.sessionId });
    }
  } catch { /* 审计失败不阻塞 */ }
  const refs = getReferences(lineId);
  // 密级 + 阅读保护（2026-08-12）：**策略优先、全局兜底**——有密级按策略矩阵（top_secret 强制水印即使全局关），无密级按全局开关
  const levelPolicy = getLevelPolicy(line?.security_level);
  const wmGlobal = getConfig('common.security.watermark_enabled', '1') !== '0';
  const cpGlobal = getConfig('common.security.copy_protect_enabled', '1') !== '0';
  const levelLabel = localizeLevels(getSecurityLevels(), req).find((l) => l.value === line?.security_level)?.label ?? line?.security_level ?? null;
  const anchors = v.markdown_content ? parseAnchors(v.markdown_content) : [];
  // 引用政策线名映射
  const ids = Array.from(new Set([lineId, ...refs.cites, ...refs.cited_by]));
  const nameMap: Record<string, string> = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, name FROM policy_lines WHERE id IN (${ph})`).all(...ids) as any[];
    rows.forEach((n) => (nameMap[n.id] = n.name));
  }
  res.json({
    line,
    version: {
      id: v.id, version_no: v.version_no, effective_from: v.effective_from,
      effective_to: v.effective_to, language: v.language, published_at: v.published_at,
      computed_status,
    },
    // 密级 + 阅读保护策略（2026-08-12）：员工端零额外请求、无权限问题；策略优先于全局开关（有密级按策略、无密级按全局）
    security: {
      level: line?.security_level ?? null,
      level_label: levelLabel,
      watermark: line?.security_level ? levelPolicy.watermark : wmGlobal,
      copy_protect: line?.security_level ? levelPolicy.copy_protect : cpGlobal,
    },
    html: v.html_content ?? '',
    anchors,
    references: {
      cites: refs.cites.map((id) => ({ id, name: nameMap[id] ?? id })),
      cited_by: refs.cited_by.map((id) => ({ id, name: nameMap[id] ?? id })),
    },
  });
}