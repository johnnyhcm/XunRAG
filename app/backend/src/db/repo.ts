// 政策相关数据访问助手（S2）
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './index.js';
import { isVersionEffective } from '../services/timezone.js';
import { E, type ErrDef } from '../services/errors.js';

export const newId = (): string => randomUUID();


/** 当前有效版本（员工端用）：status=published 且日期区间命中今天，且所属库未停用 */
export function getEffectiveVersion(lineId: string) {
  const db = getDb();
  // 多时区（2026-08-13）：先取该线所有 published 版本（含时区），Node 端按绝对时刻选当前生效
  const tzRow = db.prepare('SELECT timezone FROM policy_lines WHERE id=?').get(lineId) as { timezone: string | null } | undefined;
  const tz = tzRow?.timezone ?? null;
  const rows = db
    .prepare(`
      SELECT v.* FROM policy_versions v
      JOIN policy_libraries l ON l.id = (SELECT library_id FROM policy_lines WHERE id = v.line_id)
      WHERE v.line_id = ? AND v.status = 'published' AND l.status='active'
      ORDER BY date(v.effective_from) DESC
    `)
    .all(lineId) as any[];
  const now = new Date();
  const v = rows.find((r) => isVersionEffective(r.effective_from, r.effective_to, tz, now)) ?? rows[0];
  return v as
    | {
        id: string; line_id: string; version_no: string | null;
        effective_from: string; effective_to: string | null;
        markdown_content: string | null; html_content: string | null;
        language: string | null; published_by: string | null; published_at: string | null;
      }
    | undefined;
}

/** 当前生效版本 id 集合（口径唯一维护点，2026-08-06；多时区 2026-08-13）：
 *  published + 生效区间命中（按政策线时区 0 点转 UTC 的绝对时刻）+ 所属库未停用。
 *  检索/入库/浏览共用，保证高效模式、智能模式、员工浏览口径一致 */
export function getEffectiveVersionIds(): string[] {
  const db = getDb();
  // 多时区：SQL 只做 published + 库 active，生效判定用 Node 端 luxon（按 line 时区转 UTC 绝对时刻，与用户/服务器时区无关）
  const rows = db.prepare(`
    SELECT v.id AS id, v.effective_from, v.effective_to, pl.timezone AS tz
    FROM policy_versions v
    JOIN policy_lines pl ON pl.id = v.line_id
    JOIN policy_libraries l ON l.id = pl.library_id
    WHERE v.status='published' AND l.status='active'
  `).all() as { id: string; effective_from: string | null; effective_to: string | null; tz: string | null }[];
  const now = new Date();
  return rows.filter((r) => isVersionEffective(r.effective_from, r.effective_to, r.tz, now)).map((r) => r.id);
}

/** 发布时自动闭合旧版（PRD §4.2.3）：旧版 effective_to 设为新版开始日前一日 */
export function closeOverlappingVersions(
  db: Database.Database,
  lineId: string,
  newVersionId: string,
  newEffectiveFrom: string,
): number {
  const rows = db
    .prepare(
      `SELECT id FROM policy_versions
       WHERE line_id = ? AND id <> ? AND status = 'published'
         AND (effective_to IS NULL OR date(effective_to) >= date(?))`,
    )
    .all(lineId, newVersionId, newEffectiveFrom) as { id: string }[];
  const upd = db.prepare(
    `UPDATE policy_versions SET effective_to = date(?, '-1 day'), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
  );
  for (const r of rows) upd.run(newEffectiveFrom, r.id);
  return rows.length;
}

/** 区间不重叠校验：新版本开始日期须 ≥ 旧版本结束日期（非空时） */
export function checkNoOverlap(
  db: Database.Database,
  lineId: string,
  excludeVersionId: string,
  newEffectiveFrom: string,
): ErrDef | null {
  const conflict = db
    .prepare(
      `SELECT id, version_no, effective_from, effective_to FROM policy_versions
       WHERE line_id = ? AND id <> ? AND status = 'published'
         AND effective_to IS NOT NULL AND date(effective_to) > date(?)`,
    )
    .get(lineId, excludeVersionId, newEffectiveFrom) as
    | { id: string; version_no: string | null; effective_to: string }
    | undefined;
  return conflict
    ? E('POLICY_OVERLAP', `版本区间重叠：与已有版本 ${conflict.version_no ?? conflict.id} 的结束日期 ${conflict.effective_to} 冲突`, `Version period overlaps: conflicts with the end date ${conflict.effective_to} of existing version ${conflict.version_no ?? conflict.id}`)
    : null;
}

/** 严格区间重叠校验（编辑版本生效日期用）：
 *  新日期落在任一已发布版本的生效区间内即冲突（含长期版本 effective_to 为 NULL） */
export function checkStrictOverlap(
  db: Database.Database,
  lineId: string,
  excludeVersionId: string,
  newEffectiveFrom: string,
): ErrDef | null {
  const conflict = db
    .prepare(
      `SELECT id, version_no, effective_from, effective_to FROM policy_versions
       WHERE line_id = ? AND id <> ? AND status = 'published'
         AND date(effective_from) <= date(?)
         AND (effective_to IS NULL OR date(effective_to) >= date(?))`,
    )
    .get(lineId, excludeVersionId, newEffectiveFrom, newEffectiveFrom) as
    | { id: string; version_no: string | null; effective_from: string; effective_to: string | null }
    | undefined;
  return conflict
    ? E('POLICY_OVERLAP', `生效日期冲突：与版本 ${conflict.version_no ?? conflict.id}（${conflict.effective_from}~${conflict.effective_to ?? '长期'}）重叠`, `Effective date conflicts: overlaps with version ${conflict.version_no ?? conflict.id} (${conflict.effective_from}~${conflict.effective_to ?? 'long-term'})`)
    : null;
}

/** 引用关系双向链接（PRD §4.2.4） */
export function setReferences(db: Database.Database, fromLineId: string, toLineIds: string[]) {
  const del = db.prepare('DELETE FROM policy_references WHERE from_line_id = ?');
  const ins = db.prepare(
    `INSERT OR IGNORE INTO policy_references (id, from_line_id, to_line_id, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
  );
  const tx = db.transaction(() => {
    del.run(fromLineId);
    for (const to of toLineIds) if (to !== fromLineId) ins.run(newId(), fromLineId, to);
  });
  tx();
}

export function getReferences(lineId: string): { cites: string[]; cited_by: string[] } {
  const db = getDb();
  const cites = db
    .prepare('SELECT to_line_id FROM policy_references WHERE from_line_id = ?')
    .all(lineId)
    .map((r: any) => r.to_line_id);
  const cited_by = db
    .prepare('SELECT from_line_id FROM policy_references WHERE to_line_id = ?')
    .all(lineId)
    .map((r: any) => r.from_line_id);
  return { cites, cited_by };
}

/** Markdown 标题树 → 章节锚点（D4：slug 自动生成） */
export function parseAnchors(markdown: string): { level: number; text: string; anchor: string }[] {
  const slugify = (h: string) =>
    h
      .replace(/[（(].*?[)）]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40) || 'section';
  const out: { level: number; text: string; anchor: string }[] = [];
  for (const line of markdown.split('\n')) {
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    if (m) out.push({ level: m[1].length, text: m[2].replace(/\s+$/, ''), anchor: slugify(m[2]) });
  }
  return out;
}