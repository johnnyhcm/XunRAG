// 政策管理路由（PRD §4.2 政策库管理）
// 覆盖：库 CRUD / 政策线+版本 / 上传(Word/MD) / 异步转换 / 切片预览 / Metadata / 发布(自动闭合旧版) / 失效 / 引用关系双向
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import * as repo from '../db/repo.js';
import { newId } from '../db/repo.js';
import { callPythonConvert } from '../services/convert.js';
import { sliceByRule, aggregateChunks, chunkAnchor, estimateTokens, type SlicePlan } from '../services/slice.js';
import { saveOriginalFile, versionUploadDir } from '../services/storage.js';
import { ingestVersion, removeFromIndex, removeVersionFromIndex } from '../services/ingest.js';
import { logger } from '../services/logger.js';
import { isVersionEffective, TIMEZONES, versionStatus } from '../services/timezone.js';
import { canManageLibrary, hasPerm, isSystemAdmin } from '../services/permission.js';
import { E, sendErr } from '../services/errors.js';

export const policyRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// S6 功能权限（ISSUE #35，2026-08-07；2026-08-07 拆分：知识库全局管理/内容运营正交，PRD §3.3）
// - /policies 全路径 = 知识库内容运营（库内文件操作）：hasPerm('policy_mgmt') + 端点内 canManageLibrary 范围校验
// - /libraries 下端点各自校验（GET 任一权限；库级写操作=知识库全局管理；库内=内容运营）
// 员工端浏览/阅读/搜索在 browse.ts，不受影响；注意限定路径（Router.use 无路径=全局拦截，ISSUE #32 教训）
policyRouter.use('/policies', (req, res, next) => {
  if (!hasPerm(req.user ?? null, 'policy_mgmt')) return sendErr(req, res, 403, E('PERM_POLICY_MGMT', '无权限（需要知识库内容运营功能）', 'No permission (requires policy library content operations)'));
  next();
});

/** 库级写操作校验（知识库全局管理，全局生效无范围）：建/删/停用/属性修改 → 403 */
function requireGlobalLib(req: Request, res: Response): boolean {
  if (!hasPerm(req.user ?? null, 'policy_library_mgmt')) return (sendErr(req, res, 403, E('PERM_LIB_GLOBAL', '无权限（需要知识库全局管理功能）', 'No permission (requires policy library global management)')), false);
  return true;
}

/** 库级读权限（任一管理功能即可进入政策管理视图）：全局管理或内容运营 */
function hasAnyLibPerm(req: Request): boolean {
  return hasPerm(req.user ?? null, 'policy_library_mgmt') || hasPerm(req.user ?? null, 'policy_mgmt');
}

/** 内容运营按库授权校验（管理范围）：无内容运营权或不在范围内 → 403 */
function requireLibManage(req: Request, res: Response, libraryId: string | undefined): boolean {
  if (!hasPerm(req.user ?? null, 'policy_mgmt')) return (sendErr(req, res, 403, E('PERM_POLICY_MGMT', '无权限（需要知识库内容运营功能）', 'No permission (requires policy library content operations)')), false);
  if (!libraryId || !canManageLibrary(req.user ?? null, libraryId)) {
    sendErr(req, res, 403, E('PERM_LIB_MANAGE', '无权限管理该政策库', 'No permission to manage this library'));
    return false;
  }
  return true;
}

/** 线级管理校验：查政策线所属库并校验管理权（404/403） */
function getManagedLine(req: Request, res: Response, lineId: string): any | null {
  const line = getDb().prepare('SELECT id, library_id FROM policy_lines WHERE id=?').get(lineId) as any;
  if (!line) { sendErr(req, res, 404, E('POLICY_LINE_NOT_FOUND', '政策线不存在', 'Policy line not found')); return null; }
  if (!requireLibManage(req, res, line.library_id)) return null;
  return line;
}

/** 可见条件归一化（2026-08-07 防御：PATCH 传入 GET 返回的 JSON 字符串会被 JSON.stringify 双层编码 → 权限判定失效全员可见）
 *  数组 → 原样；字符串 → 解析成数组；空/非法 → null（全员可见语义由 null 表达） */
function normalizeVisibleRules(v: any): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) && p.length ? JSON.stringify(p) : null; } catch { return null; }
  }
  return Array.isArray(v) && v.length ? JSON.stringify(v) : null;
}

// ---------- 政策库 ----------
policyRouter.post('/libraries', (req, res) => {
  if (!requireGlobalLib(req, res)) return; // 建库 = 知识库全局管理
  const { name, description, visible_rules, apply_rules } = req.body ?? {};
  if (!name?.trim()) return sendErr(req, res, 400, E('NAME_REQUIRED', 'name 必填', 'name is required'));
  const id = newId();
  getDb().prepare(
    `INSERT INTO policy_libraries (id, name, description, visible_rules, apply_rules, created_at, updated_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
  ).run(id, name.trim(), description ?? null,
    visible_rules && Array.isArray(visible_rules) && visible_rules.length ? JSON.stringify(visible_rules) : null,
    apply_rules && Array.isArray(apply_rules) && apply_rules.length ? JSON.stringify(apply_rules) : null);
  res.json(getLibrary(id));
});

policyRouter.get('/libraries', (req, res) => {
  if (!hasAnyLibPerm(req)) return sendErr(req, res, 403, E('PERM_LIB_MGMT', '无权限（需要知识库管理功能）', 'No permission (requires policy library management)'));
  const db = getDb();
  const rows = db.prepare(
    `SELECT l.*, (SELECT COUNT(*) FROM policy_lines pl WHERE pl.library_id = l.id) AS file_count
     FROM policy_libraries l ORDER BY l.created_at DESC`,
  ).all() as any[];
  // 可见范围：系统管理员/全局管理=全部；仅内容运营=按管理范围过滤
  const user = req.user ?? null;
  const isGlobal = isSystemAdmin(user) || hasPerm(user, 'policy_library_mgmt');
  const libs = isGlobal ? rows : rows.filter((l) => canManageLibrary(user, l.id));
  res.json({ libraries: libs });
});

function getLibrary(id: string) {
  return getDb().prepare('SELECT * FROM policy_libraries WHERE id = ?').get(id);
}

policyRouter.get('/libraries/:id', (req, res) => {
  const lib = getLibrary(req.params.id);
  if (!lib) return sendErr(req, res, 404, E('LIB_NOT_FOUND', '库不存在', 'Library not found'));
  if (!hasAnyLibPerm(req)) return sendErr(req, res, 403, E('PERM_LIB_MGMT', '无权限（需要知识库管理功能）', 'No permission (requires policy library management)'));
  // 全局管理可看所有库；仅内容运营须在管理范围内
  const user = req.user ?? null;
  if (!isSystemAdmin(user) && !hasPerm(user, 'policy_library_mgmt') && !canManageLibrary(user, req.params.id)) return sendErr(req, res, 403, E('PERM_LIB_MANAGE', '无权限管理该政策库', 'No permission to manage this library'));
  res.json(lib);
});

policyRouter.patch('/libraries/:id', (req, res) => {
  if (!requireGlobalLib(req, res)) return; // 改属性/可见性/状态 = 知识库全局管理
  const { name, description, status, visible_rules, apply_rules } = req.body ?? {};
  const db = getDb();
  const cur: any = getLibrary(req.params.id);
  if (!cur) return sendErr(req, res, 404, E('LIB_NOT_FOUND', '库不存在', 'Library not found'));
  const normRules = visible_rules !== undefined ? normalizeVisibleRules(visible_rules) : cur.visible_rules;
  // 适用范围规则（库级，NULL=全员适用）——防御解析（字符串→数组）
  let normApply = cur.apply_rules;
  if (apply_rules !== undefined) {
    const raw = apply_rules;
    const rules = typeof raw === 'string' ? (() => { try { const p = JSON.parse(raw); return Array.isArray(p) ? p : null; } catch { return null; } })() : raw;
    normApply = rules && Array.isArray(rules) && rules.length ? JSON.stringify(rules) : null;
  }
  db.prepare(
    `UPDATE policy_libraries SET name=?, description=?, status=?, visible_rules=?, apply_rules=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`,
  ).run(
    name ?? cur.name, description ?? cur.description, status ?? cur.status, normRules, normApply, req.params.id,
  );
  logger.audit({ action: 'edit_library_visibility', libraryId: req.params.id, hasVisible: visible_rules !== undefined, sessionId: req.sessionId });
  // 库停用/启用：向量库保留（方案 B：检索时按生效集合过滤，库 active 已含在 getEffectiveVersionIds 口径内，无需刷新）
  // 2026-08-06 方案 B 移除 refreshLineIndex 调用
  res.json(getLibrary(req.params.id));
});

policyRouter.delete('/libraries/:id', async (req, res) => {
  if (!requireGlobalLib(req, res)) return; // 删库 = 知识库全局管理
  const db = getDb();
  const lib: any = db.prepare('SELECT * FROM policy_libraries WHERE id=?').get(req.params.id);
  if (!lib) return sendErr(req, res, 404, E('LIB_NOT_FOUND', '库不存在', 'Library not found'));

  // 硬删前置（2026-08-08 方案 A：删库仅限空库——全局管理不碰内容，任何库内文件（含废止/编辑中）须内容运营先清理）
  const cnt: any = db.prepare('SELECT COUNT(*) AS c FROM policy_lines WHERE library_id=?').get(req.params.id);
  if (cnt.c > 0) {
    return sendErr(req, res, 400, E('LIB_DELETE_NONEMPTY', `仅可删除空库：库内仍有 ${cnt.c} 个政策文件（含废止/编辑中），请知识库内容运营先清理`, `Only empty libraries can be deleted: the library still has ${cnt.c} policy files (incl. revoked/editing); ask content operations to clean up first`));
  }

  // 清理库下剩余政策线（未发布/已废止）及关联数据
  db.transaction(() => {
    const lineIds = db.prepare('SELECT id FROM policy_lines WHERE library_id=?').all(req.params.id) as { id: string }[];
    for (const l of lineIds) {
      db.prepare('DELETE FROM policy_references WHERE from_line_id=? OR to_line_id=?').run(l.id, l.id);
      const vids = db.prepare('SELECT id FROM policy_versions WHERE line_id=?').all(l.id) as { id: string }[];
      for (const v of vids) {
        db.prepare('DELETE FROM policy_chunks WHERE version_id=?').run(v.id);
        db.prepare('DELETE FROM policy_images WHERE version_id=?').run(v.id);
        removeFromIndex(l.id).catch(() => {});
      }
      db.prepare('DELETE FROM policy_versions WHERE line_id=?').run(l.id);
      db.prepare('DELETE FROM policy_lines WHERE id=?').run(l.id);
    }
    db.prepare('DELETE FROM policy_libraries WHERE id=?').run(req.params.id);
  })();

  // 清理上传文件目录（如有残留）
  try {
    const dir = path.join(config.root, 'data', 'uploads', req.params.id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* 忽略 */ }

  res.json({ ok: true });
});

// ---------- 政策线 + 版本 ----------
// 创建政策线 + 首个草稿版本
policyRouter.post('/libraries/:libId/policies', (req, res) => {
  if (!requireLibManage(req, res, req.params.libId)) return; // 内容运营 + 范围
  const { name, policy_type, doc_no, topic, publish_org, apply_rules,
    security_level, visibility, tags, legal_basis, visible_rules } = req.body ?? {};
  if (!name?.trim()) return sendErr(req, res, 400, E('NAME_REQUIRED', 'name 必填', 'name is required'));
  // 2026-08-13：主题多选（policy_topics 字典 id 数组）——数组存 JSON；字符串兼容（旧/浏览筛选）
  const topicVal = Array.isArray(topic) ? (topic.length ? JSON.stringify(topic) : null) : (topic ?? null);
  const db = getDb();
  const lineId = newId();
  const versionId = newId();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO policy_lines (id, library_id, name, policy_type, doc_no, topic, publish_org,
        apply_rules, security_level, visibility, tags, legal_basis, visible_rules, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'),strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
    ).run(lineId, req.params.libId, name.trim(), policy_type ?? null, doc_no ?? null,
      topicVal, publish_org ?? null, apply_rules && Array.isArray(apply_rules) && apply_rules.length ? JSON.stringify(apply_rules) : null,
      security_level ?? null, visibility ?? null, tags ?? null, legal_basis ?? null,
      visible_rules && Array.isArray(visible_rules) && visible_rules.length ? JSON.stringify(visible_rules) : null);
    db.prepare(
      `INSERT INTO policy_versions (id, line_id, status, convert_status, created_at, updated_at) VALUES (?, ?, 'draft', 'pending', strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
    ).run(versionId, lineId);
  });
  tx();
  res.json({ line_id: lineId, version_id: versionId });
});

// 政策线列表（管理端）：派生状态（已生效/待生效/已废止/未发布）
// 2026-08-08 方案 A：仅内容运营（管理范围）可看文件列表——全局管理不显示文件（内容隔离）
policyRouter.get('/libraries/:libId/policies', (req, res) => {
  const user = req.user ?? null;
  if (!hasPerm(user, 'policy_mgmt') || !canManageLibrary(user, req.params.libId)) {
    return sendErr(req, res, 403, E('PERM_LIB_CONTENT', '无权限查看该政策库内容（需知识库内容运营授权）', 'No permission to view this library content (requires content operations authorization)'));
  }
  const db = getDb();
  const lines = db.prepare(
    `SELECT pl.*, l.name AS library_name,
       (SELECT COUNT(*) FROM policy_versions v WHERE v.line_id=pl.id AND v.status='published') AS published_count,
       (SELECT COUNT(*) FROM policy_versions v WHERE v.line_id=pl.id AND v.status='invalid') AS invalid_count,
       (SELECT COUNT(*) FROM policy_versions v WHERE v.line_id=pl.id) AS version_count,
       (SELECT MAX(v.updated_at) FROM policy_versions v WHERE v.line_id=pl.id) AS max_updated_at
     FROM policy_lines pl JOIN policy_libraries l ON pl.library_id=l.id
     WHERE pl.library_id=? AND EXISTS (SELECT 1 FROM policy_versions v WHERE v.line_id=pl.id)
     ORDER BY pl.created_at DESC`,
  ).all(req.params.libId) as any[];
  // 派生状态（2026-08-13 多时区：current_version/active 按线时区绝对时刻判，SQL 不再 date('now','localtime')）
  const now = new Date();
  for (const l of lines) {
    const pubs = db.prepare(
      `SELECT version_no, effective_from, effective_to FROM policy_versions WHERE line_id=? AND status='published' ORDER BY date(effective_from) DESC`,
    ).all(l.id) as { version_no: string | null; effective_from: string | null; effective_to: string | null }[];
    const cur = pubs.find((v) => isVersionEffective(v.effective_from, v.effective_to, l.timezone ?? null, now));
    l.current_version_no = cur?.version_no ?? null;
    l.derived_status = cur ? 'active' : l.published_count > 0 ? 'pending' : l.invalid_count > 0 ? 'invalid' : 'unpublished';
  }
  res.json({ policies: lines });
});

policyRouter.get('/policies/:lineId', (req, res) => {
  if (!getManagedLine(req, res, req.params.lineId)) return;
  const db = getDb();
  const line = db.prepare('SELECT * FROM policy_lines WHERE id=?').get(req.params.lineId);
  if (!line) return sendErr(req, res, 404, E('POLICY_LINE_NOT_FOUND', '政策线不存在', 'Policy line not found'));
  // 版本级派生状态（2026-08-06 定案；2026-08-13 多时区：computed_status 按政策线时区绝对时刻判）
  const tz = (line as any)?.timezone ?? null;
  const versions = db.prepare(
    `SELECT id, version_no, status, effective_from, effective_to, language, change_note,
       convert_status, convert_quality, index_status, index_error, published_at, created_at
     FROM policy_versions WHERE line_id=? ORDER BY created_at DESC`,
  ).all(req.params.lineId) as any[];
  const now = new Date();
  for (const v of versions) {
    v.computed_status = v.status === 'draft' ? 'draft' : v.status === 'invalid' ? 'invalid' : versionStatus(v.effective_from, v.effective_to, tz, now);
  }
  res.json({ line, versions, timezone: (line as any)?.timezone ?? null });
});

policyRouter.patch('/policies/:lineId', (req, res) => {
  if (!getManagedLine(req, res, req.params.lineId)) return;
  const db = getDb();
  const cur: any = db.prepare('SELECT * FROM policy_lines WHERE id=?').get(req.params.lineId);
  if (!cur) return sendErr(req, res, 404, E('POLICY_LINE_NOT_FOUND', '政策线不存在', 'Policy line not found'));
  const f = ['name','policy_type','doc_no','publish_org',
    'security_level',
    'visibility','tags','legal_basis'] as const;
  const sets: string[] = [];
  const vals: any[] = [];
  // 2026-08-13：主题多选（policy_topics 字典 id 数组）——数组存 JSON；字符串兼容（旧数据/浏览筛选）
  if ('topic' in (req.body ?? {})) {
    const t = (req.body as any).topic;
    if (Array.isArray(t)) { sets.push('topic=?'); vals.push(t.length ? JSON.stringify(t) : null); }
    else { sets.push('topic=?'); vals.push(t ?? null); }
  }
  // 2026-08-12：密级必填——仅拒绝"清空已有密级"（原值非空 → 传空/传 null）；新建政策本就是 NULL 的更新（null→null）放行
  if ('security_level' in (req.body ?? {})) {
    const bodyVal = (req.body as any).security_level;
    const bodyEmpty = bodyVal === undefined || bodyVal === null || String(bodyVal).trim() === '';
    if (bodyEmpty && cur?.security_level) {
      return sendErr(req, res, 400, E('POLICY_SECURITY_LEVEL_REQUIRED', '密级必填（安全属性不可清空，请选择 公开/内部/机密/绝密 等档位）', 'Security level is required (a security attribute cannot be cleared; select Public/Internal/Confidential/Top secret)'));
    }
  }
  for (const k of f) if (k in (req.body ?? {})) { sets.push(`${k}=?`); vals.push(req.body[k]); }
  // 2026-08-13 多时区：时区线级可更新（仅未发布；已发布锁定——与 publish 同规则，新版本必须与旧版一致）
  //   空值（null/undefined/''）视为未提供——新建政策时区为空，Step2 保存不应触发校验（2026-08-13 修复）
  if ('timezone' in (req.body ?? {}) && (req.body as any).timezone) {
    const tzVal = (req.body as any).timezone;
    if (!TIMEZONES.includes(tzVal)) return sendErr(req, res, 400, E('POLICY_INVALID_TZ', '时区不合法（IANA 时区）', 'Invalid timezone (IANA timezone)'));
    const hasPub = !!db.prepare("SELECT 1 FROM policy_versions WHERE line_id=? AND status='published'").get(req.params.lineId);
    if (hasPub && cur?.timezone && tzVal !== cur.timezone) {
      return sendErr(req, res, 400, E('POLICY_TZ_LOCKED', '该政策已发布版本，时区已锁定（新版本必须与旧版一致）', 'This policy has a published version; timezone is locked (new versions must match)'));
    }
    sets.push('timezone=?'); vals.push(tzVal);
  }
  // 适用范围规则（apply_rules，null=继承库）——防御解析（字符串→数组，防双重编码），同 visible_rules
  if ('apply_rules' in (req.body ?? {})) {
    const raw = req.body.apply_rules;
    const rules = typeof raw === 'string' ? (() => { try { const p = JSON.parse(raw); return Array.isArray(p) ? p : null; } catch { return null; } })() : raw;
    sets.push('apply_rules=?');
    vals.push(rules && Array.isArray(rules) && rules.length ? JSON.stringify(rules) : null);
  }
  // 文件可见条件（visible_rules，null=继承库）——⊆ 校验（同字段值域超出→warnings，不拦截）
  let warnings: { field: string; value: string; allowed: string[] }[] = [];
  if ('visible_rules' in (req.body ?? {})) {
    const newRulesRaw = req.body.visible_rules; // null=继承库
    // 2026-08-07 防御：字符串（GET 返回值）→ 解析，防双层编码；数组 → 原样
    const newRules = typeof newRulesRaw === 'string' ? (() => { try { const p = JSON.parse(newRulesRaw); return Array.isArray(p) ? p : null; } catch { return null; } })() : newRulesRaw;
    sets.push('visible_rules=?');
    vals.push(newRules && Array.isArray(newRules) && newRules.length ? JSON.stringify(newRules) : null);
    if (newRules && Array.isArray(newRules) && newRules.length) {
      // 同字段值域超出检测（启发式：文件某字段值 ∉ 库同字段允许值并集 → warning）
      const lib = db.prepare('SELECT visible_rules FROM policy_libraries WHERE id=?').get(cur.library_id) as any;
      if (lib?.visible_rules) {
        try {
          const libRules = JSON.parse(lib.visible_rules) as { conditions?: { field: string; values: string[] }[] }[];
          const libFieldValues = new Map<string, Set<string>>();
          for (const r of libRules) for (const c of r.conditions ?? []) {
            if (!libFieldValues.has(c.field)) libFieldValues.set(c.field, new Set());
            for (const v of c.values ?? []) libFieldValues.get(c.field)!.add(v);
          }
          for (const r of newRules) for (const c of r.conditions ?? []) {
            const allowed = libFieldValues.get(c.field);
            if (!allowed || !allowed.size) continue; // 库该字段无限制（空=全员/未约束）
            for (const v of c.values ?? []) if (!allowed.has(v)) warnings.push({ field: c.field, value: v, allowed: [...allowed] });
          }
        } catch { /* 库规则 JSON 损坏，跳过校验 */ }
      }
    }
    logger.audit({ action: 'edit_line_visibility', lineId: req.params.lineId, warnings: warnings.length, sessionId: req.sessionId });
  }
  if (sets.length) {
    sets.push(`updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
    vals.push(req.params.lineId);
    db.prepare(`UPDATE policy_lines SET ${sets.join(', ')} WHERE id=?`).run(...vals);
  }
  res.json({ line: db.prepare('SELECT * FROM policy_lines WHERE id=?').get(req.params.lineId), warnings });
});

// 对已有政策线新建一个草稿版本（发新版时用，配合发布自动闭合旧版）
policyRouter.post('/policies/:lineId/versions', (req, res) => {
  if (!getManagedLine(req, res, req.params.lineId)) return;
  const db = getDb();
  const line = db.prepare('SELECT id FROM policy_lines WHERE id=?').get(req.params.lineId);
  if (!line) return sendErr(req, res, 404, E('POLICY_LINE_NOT_FOUND', '政策线不存在', 'Policy line not found'));
  const versionId = newId();
  db.prepare(
    `INSERT INTO policy_versions (id, line_id, status, convert_status, created_at, updated_at) VALUES (?, ?, 'draft', 'pending', strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
  ).run(versionId, req.params.lineId);
  res.json({ version_id: versionId, line_id: req.params.lineId });
});

// 上传 Word/MD → 异步转换 → 规则切片 → 入库（草稿）
policyRouter.post(
  '/policies/:lineId/versions/:versionId/upload',
  upload.single('file'),
  async (req: Request, res: Response) => {
    if (!getManagedLine(req, res, req.params.lineId)) return;
    const db = getDb();
    const version: any = db.prepare('SELECT * FROM policy_versions WHERE id=?').get(req.params.versionId);
    if (!version) return sendErr(req, res, 404, E('POLICY_VERSION_NOT_FOUND', '版本不存在', 'Version not found'));
    if (version.status !== 'draft') return sendErr(req, res, 400, E('POLICY_ONLY_DRAFT_UPLOAD', '仅草稿可上传', 'Only drafts can be uploaded'));
    if (!req.file) return sendErr(req, res, 400, E('POLICY_NO_FILE', '未提供 file', 'No file provided'));
    // 限制扩展名
    const ext = (req.file.originalname.toLowerCase().match(/\.(\w+)$/)?.[1]) ?? '';
    if (!['docx', 'md', 'markdown'].includes(ext)) {
      return sendErr(req, res, 400, E('POLICY_UNSUPPORTED_FORMAT', '仅支持 .docx / .md', 'Only .docx / .md are supported'));
    }
    const lib: any = db.prepare('SELECT l.* FROM policy_lines pl JOIN policy_libraries l ON pl.library_id=l.id WHERE pl.id=?').get(req.params.lineId);
    if (!lib) return sendErr(req, res, 404, E('POLICY_LINE_LIB_NOT_FOUND', '政策线/库不存在', 'Policy line / library not found'));

    db.prepare(`UPDATE policy_versions SET convert_status='converting', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(req.params.versionId);
    try {
      const { storedPath, storedName } = saveOriginalFile(lib.id, req.params.versionId, req.file.originalname, req.file.buffer);
      const mediaDir = versionUploadDir(lib.id, req.params.versionId);
      const result = await callPythonConvert(storedPath, mediaDir);
      // PRD §4.2.2 段落+切分线模型
      const plan = sliceByRule(result.segments);
      const chunks = aggregateChunks(plan);
      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE policy_versions SET markdown_content=?, html_content=?, original_file_path=?, original_file_name=?,
            convert_status='preview', convert_quality=?, language=?, slice_plan=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`,
        ).run(result.markdown, result.html, storedPath, storedName, result.quality, inferLang(result.segments), JSON.stringify(plan), req.params.versionId);
        // 聚合 chunks 入 policy_chunks 表（供 S3 检索读取）
        db.prepare('DELETE FROM policy_chunks WHERE version_id=?').run(req.params.versionId);
        const ins = db.prepare(
          `INSERT INTO policy_chunks (id, version_id, chunk_index, content, level, has_table, retained, type, start_pos, end_pos, language, section_path, anchor, token_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
        );
        for (const c of chunks) {
          const firstSeg = plan.segments[c.segment_indices[0]] ?? null;
          ins.run(newId(), req.params.versionId, c.chunk_index, c.content, c.level || null,
            c.has_table ? 1 : 0, c.retained ? 1 : 0, c.type, c.segment_indices[0], c.segment_indices[c.segment_indices.length - 1],
            firstSeg?.lang ?? 'zh', c.section_path || null,
            c.section_path ? chunkAnchor(c.section_path) : null, estimateTokens(c.content));
        }
        // 图片记录
        db.prepare('DELETE FROM policy_images WHERE version_id=?').run(req.params.versionId);
        const insImg = db.prepare(
          `INSERT INTO policy_images (id, version_id, original_name, stored_path, position, created_at) VALUES (?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
        );
        for (const im of result.images) insImg.run(newId(), req.params.versionId, im.original_name, im.stored_path, im.position);
      });
      tx();
      res.json({ version_id: req.params.versionId, convert_status: 'preview', segment_count: plan.segments.length, chunk_count: chunks.length, quality: result.quality });
    } catch (e: any) {
      db.prepare(`UPDATE policy_versions SET convert_status='pending', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(req.params.versionId);
      console.error(`[convert] 转换失败 ${req.params.versionId}: ${e?.message ?? e}`);
      sendErr(req, res, 502, E('CONVERT_FAILED', '转换失败', 'Conversion failed'));
    }
  },
);

function inferLang(segments: { lang: string }[]): string {
  const counts: Record<string, number> = {};
  for (const s of segments) counts[s.lang] = (counts[s.lang] ?? 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top?.[0] ?? 'zh';
}

// 版本详情（PRD §4.2.2 段落+切分线模型）
policyRouter.get('/policies/:lineId/versions/:versionId', (req, res) => {
  if (!getManagedLine(req, res, req.params.lineId)) return;
  const db = getDb();
  const version: any = db.prepare('SELECT * FROM policy_versions WHERE id=?').get(req.params.versionId);
  if (!version) return sendErr(req, res, 404, E('POLICY_VERSION_NOT_FOUND', '版本不存在', 'Version not found'));
  const line = db.prepare('SELECT * FROM policy_lines WHERE id=?').get(req.params.lineId);
  let plan: SlicePlan | null = null;
  try { plan = version.slice_plan ? JSON.parse(version.slice_plan) : null; } catch { plan = null; }
  let segments: any[] = [];
  let splits: boolean[] = [];
  if (plan) {
    segments = plan.segments; splits = plan.splits;
  } else {
    const chunks = db.prepare(`SELECT chunk_index, content, level, has_table, retained, type, section_path FROM policy_chunks WHERE version_id=? ORDER BY chunk_index`).all(req.params.versionId) as any[];
    segments = chunks.map((c, i) => ({ index: i, text: c.content, lang: 'zh', type: c.type, level: c.level ?? '', has_table: !!c.has_table, tokens: c.content.length, retained: !!c.retained, isPureHeading:false, section_path: c.section_path }));
    splits = segments.map((_, i) => i > 0);
  }
  res.json({ line, version: { ...version, slice_plan: undefined }, segments, splits, chunks: aggregateChunks(plan ?? { segments: segments as any, splits }) });
});

// 版本属性编辑（已发布可编辑；已废止只读）
// 字段：version_no / effective_from / effective_to / change_note / language
policyRouter.patch('/policies/:lineId/versions/:versionId', (req, res) => {
  if (!getManagedLine(req, res, req.params.lineId)) return;
  const { version_no, effective_from, effective_to, change_note, language } = req.body ?? {};
  const db = getDb();
  const v: any = db.prepare('SELECT * FROM policy_versions WHERE id=?').get(req.params.versionId);
  if (!v) return sendErr(req, res, 404, E('POLICY_VERSION_NOT_FOUND', '版本不存在', 'Version not found'));
  if (v.status === 'invalid') return sendErr(req, res, 400, E('POLICY_INVALID_NOT_EDITABLE', '已废止版本不可编辑', 'Revoked versions cannot be edited'));
  // 版本号非空校验（发布后已必填；编辑时若传空拦截）
  if (version_no !== undefined && !String(version_no).trim()) {
    return sendErr(req, res, 400, E('POLICY_VERSION_NO_REQUIRED', '版本号不能为空', 'Version number cannot be empty'));
  }
  // 修改生效开始日期时严格校验区间重叠（含长期版本；排除自身）
  if (effective_from && String(effective_from) !== v.effective_from) {
    const overlapErr = repo.checkStrictOverlap(db, v.line_id, v.id, String(effective_from));
    if (overlapErr) return sendErr(req, res, 409, overlapErr);
  }
  db.prepare(
    `UPDATE policy_versions SET version_no=?, effective_from=?, effective_to=?, change_note=?, language=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`,
  ).run(
    version_no ?? v.version_no, effective_from ?? v.effective_from, effective_to ?? v.effective_to,
    change_note ?? v.change_note, language ?? v.language, req.params.versionId,
  );
  // 生效日期变更：不刷新向量（方案 B：检索时按生效集合动态过滤，改期即改变集合，无需入库侧同步）
  // 2026-08-06 方案 B 移除 refreshLineIndex 调用
  logger.audit({ action: 'edit_version', lineId: req.params.lineId, versionId: req.params.versionId, sessionId: req.sessionId });
  res.json(db.prepare('SELECT * FROM policy_versions WHERE id=?').get(req.params.versionId));
});

// 2026-08-11：保存切片 plan（事务：slice_plan + 重建 policy_chunks）——plans 接口与 publish 接口共用，
//   保证"发布即最新分割"（前端手工调整的切分线与后台 DB/向量库同步，不依赖用户先点保存切片）
function saveSlicePlan(db: any, versionId: string, plan: SlicePlan): number {
  const chunks = aggregateChunks(plan);
  db.transaction(() => {
    db.prepare(`UPDATE policy_versions SET slice_plan=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(JSON.stringify(plan), versionId);
    db.prepare('DELETE FROM policy_chunks WHERE version_id=?').run(versionId);
    const ins = db.prepare(
      `INSERT INTO policy_chunks (id, version_id, chunk_index, content, level, has_table, retained, type, start_pos, end_pos, language, section_path, anchor, token_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
    );
    for (const c of chunks) {
      const firstSeg = plan.segments[c.segment_indices[0]] ?? null;
      ins.run(newId(), versionId, c.chunk_index, c.content, c.level || null,
        c.has_table ? 1 : 0, c.retained ? 1 : 0, c.type, c.segment_indices[0], c.segment_indices[c.segment_indices.length - 1],
        firstSeg?.lang ?? 'zh', c.section_path || null,
        c.section_path ? chunkAnchor(c.section_path) : null, estimateTokens(c.content));
    }
  })();
  return chunks.length;
}

// 切片方案更新（PRD §4.2.2：拖拽切分线 / retained 切换 / 增删切分线）
// 草稿/已发布均可改；已废止不可。已发布版本改后触发重新向量化（原地覆盖，不生成小版本号）
policyRouter.put('/policies/:lineId/versions/:versionId/chunks', async (req, res) => {
  if (!getManagedLine(req, res, req.params.lineId)) return;
  const db = getDb();
  const version: any = db.prepare('SELECT * FROM policy_versions WHERE id=?').get(req.params.versionId);
  if (!version) return sendErr(req, res, 404, E('POLICY_VERSION_NOT_FOUND', '版本不存在', 'Version not found'));
  if (version.status === 'invalid') return sendErr(req, res, 400, E('POLICY_INVALID_NO_SLICE', '已废止版本不可调整切片', 'Slices of revoked versions cannot be adjusted'));
  const plan: SlicePlan = { segments: req.body?.segments ?? [], splits: req.body?.splits ?? [] };
  if (plan.segments.length !== plan.splits.length) return sendErr(req, res, 400, E('SLICE_LEN_MISMATCH', 'segments/splits 长度不一致', 'segments/splits length mismatch'));
  if (plan.splits[0]) return sendErr(req, res, 400, E('SLICE_NO_SPLIT_BEFORE_FIRST', '首段之前不可有切分线', 'No split line allowed before the first segment'));
  const chunkCount = saveSlicePlan(db, req.params.versionId, plan);
  // 已发布版本：切片调整后重新向量化（覆盖同版本）
  if (version.status === 'published') {
    try { await ingestVersion(req.params.lineId, req.params.versionId); }
    catch (e) { console.error('[ingest] re-slice version', req.params.versionId, e); }
  }
  res.json({ ok: true, segment_count: plan.segments.length, chunk_count: chunkCount });
});

// 发布：配生效日期 + 二次确认已在前端；后端校验 + 自动闭合旧版
policyRouter.post('/policies/:lineId/versions/:versionId/publish', async (req, res) => {
  if (!getManagedLine(req, res, req.params.lineId)) return;
  const { effective_from, effective_to, version_no, language, change_note, security_level, timezone } = req.body ?? {};
  if (!effective_from) return sendErr(req, res, 400, E('POLICY_EFF_FROM_REQUIRED', 'effective_from 必填', 'effective_from is required'));
  if (!version_no?.trim()) return sendErr(req, res, 400, E('POLICY_VERSION_NO_REQUIRED', '版本号必填', 'Version number is required'));
  // 2026-08-12：密级发布必填（上线安全检查）——发布弹窗提交 security_level；空则拒绝（不静默默认，安全决策须管理员显式选择）
  if (!security_level?.trim()) return sendErr(req, res, 400, E('POLICY_SECURITY_LEVEL_REQUIRED_PUBLISH', '请选择密级后再发布（密级是上线安全检查，草稿可暂不设置）', 'Select a security level before publishing (security check; drafts may skip it)'));
  // 2026-08-13 多时区：时区线级（首版发布设置，已发布则锁定一致）
  if (timezone && !TIMEZONES.includes(timezone)) return sendErr(req, res, 400, E('POLICY_INVALID_TZ', '时区不合法（IANA 时区）', 'Invalid timezone (IANA timezone)'));
  const db = getDb();
  const version: any = db.prepare('SELECT * FROM policy_versions WHERE id=?').get(req.params.versionId);
  if (!version) return sendErr(req, res, 404, E('POLICY_VERSION_NOT_FOUND', '版本不存在', 'Version not found'));
  if (version.status !== 'draft') return sendErr(req, res, 400, E('POLICY_ONLY_DRAFT_PUBLISH', '仅草稿可发布', 'Only drafts can be published'));
  // 已发布过版本 → 时区锁定（新版本必须与旧版一致）；未发布过 → 首版必须带时区（默认前端浏览器时区）
  const lineRow: any = db.prepare('SELECT timezone FROM policy_lines WHERE id=?').get(req.params.lineId);
  const hasPublished = !!db.prepare("SELECT 1 FROM policy_versions WHERE line_id=? AND status='published' AND id<>?").get(req.params.lineId, req.params.versionId);
  if (hasPublished) {
    if (timezone && lineRow?.timezone && timezone !== lineRow.timezone) {
      return sendErr(req, res, 400, E('POLICY_TZ_LOCKED', '该政策已发布版本，时区已锁定（与旧版一致），不可修改', 'This policy has a published version; timezone is locked (must match previous version), cannot be modified'));
    }
  } else if (!timezone) {
    return sendErr(req, res, 400, E('POLICY_TZ_FIRST_PUBLISH', '首个版本发布请选择时区（默认北京时间）', 'Select a timezone for the first version publish (defaults to Beijing time)'));
  }

  // 2026-08-11：发布即保存最新切片分割（前端始终携带当前 segments/splits；与 plans 接口同校验同事务，
  //   保证前端手工调整与后台 slice_plan/policy_chunks/向量库一致，不依赖用户先点"保存切片"）
  if (Array.isArray(req.body?.segments) && Array.isArray(req.body?.splits)) {
    const plan: SlicePlan = { segments: req.body.segments, splits: req.body.splits };
    if (plan.segments.length !== plan.splits.length) return sendErr(req, res, 400, E('SLICE_LEN_MISMATCH', 'segments/splits 长度不一致', 'segments/splits length mismatch'));
    if (plan.splits[0]) return sendErr(req, res, 400, E('SLICE_NO_SPLIT_BEFORE_FIRST', '首段之前不可有切分线', 'No split line allowed before the first segment'));
    saveSlicePlan(db, req.params.versionId, plan);
  }

  const overlapErr = repo.checkNoOverlap(db, req.params.lineId, req.params.versionId, effective_from);
  if (overlapErr) return sendErr(req, res, 409, overlapErr);

  const tx = db.transaction(() => {
    repo.closeOverlappingVersions(db, req.params.lineId, req.params.versionId, effective_from);
    // 2026-08-12：发布同步更新密级（发布时确认的安全属性）
    db.prepare(`UPDATE policy_lines SET security_level=?, timezone=COALESCE(?, timezone), updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(security_level.trim(), timezone ?? null, req.params.lineId);
    db.prepare(
      `UPDATE policy_versions SET status='published', version_no=?, effective_from=?, effective_to=?,
        language=?, change_note=?, convert_status='confirmed', published_by=?, published_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`,
    ).run(version_no ?? null, effective_from, effective_to ?? null, language ?? version.language ?? 'zh',
      change_note ?? null, req.sessionId ?? null, req.params.versionId);
  });
  tx();
  // 异步向量化入库 失败仅记错不阻塞发布
  try { await ingestVersion(req.params.lineId, req.params.versionId); }
  catch (e) { console.error('[ingest] version', req.params.versionId, e); }
  logger.audit({ action: 'publish', lineId: req.params.lineId, versionId: req.params.versionId, effective_from, version_no, sessionId: req.sessionId });
  res.json({ ok: true, version_id: req.params.versionId, status: 'published' });
});

// 重新索引（A 项，2026-08-06）：索引失败后管理员重试入口；成功清 index_error
policyRouter.post('/policies/:lineId/versions/:versionId/reindex', async (req, res) => {
  if (!getManagedLine(req, res, req.params.lineId)) return;
  const db = getDb();
  const v: any = db.prepare('SELECT status FROM policy_versions WHERE id=?').get(req.params.versionId);
  if (!v) return sendErr(req, res, 404, E('POLICY_VERSION_NOT_FOUND', '版本不存在', 'Version not found'));
  if (v.status !== 'published') return sendErr(req, res, 400, E('POLICY_ONLY_PUBLISHED_REINDEX', '仅已发布版本可重新索引', 'Only published versions can be re-indexed'));
  try {
    const r = await ingestVersion(req.params.lineId, req.params.versionId);
    logger.audit({ action: 'reindex', lineId: req.params.lineId, versionId: req.params.versionId, sessionId: req.sessionId });
    res.json({ ok: true, indexed: r.indexed });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// 失效（软删除归档，不进检索）——方案 B：按版本删向量（该线其他已发布版本保留）
policyRouter.post('/policies/:lineId/versions/:versionId/invalidate', (req, res) => {
  if (!getManagedLine(req, res, req.params.lineId)) return;
  getDb().prepare(
    `UPDATE policy_versions SET status='invalid', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`,
  ).run(req.params.versionId);
  removeVersionFromIndex(req.params.versionId).catch(() => {});
  logger.audit({ action: 'invalidate', lineId: req.params.lineId, versionId: req.params.versionId, sessionId: req.sessionId });
  res.json({ ok: true, status: 'invalid' });
});

// 强制清理整条政策线（含全部版本/引用/向量数据/上传文件）
// 高危操作，前端弹窗强警告"不可恢复"；所有状态（未发布/已发布/已废止）均可执行
policyRouter.delete('/policies/:lineId', (req, res) => {
  if (!getManagedLine(req, res, req.params.lineId)) return;
  const db = getDb();
  const line: any = db.prepare('SELECT id, library_id FROM policy_lines WHERE id=?').get(req.params.lineId);
  if (!line) return sendErr(req, res, 404, E('POLICY_LINE_NOT_FOUND', '政策线不存在', 'Policy line not found'));
  db.transaction(() => {
    // 清理引用关系（双向）
    db.prepare('DELETE FROM policy_references WHERE from_line_id=? OR to_line_id=?').run(req.params.lineId, req.params.lineId);
    // 清理该 line 下所有版本的 chunks/images
    const vids = db.prepare('SELECT id FROM policy_versions WHERE line_id=?').all(req.params.lineId) as { id: string }[];
    for (const v of vids) {
      db.prepare('DELETE FROM policy_chunks WHERE version_id=?').run(v.id);
      db.prepare('DELETE FROM policy_images WHERE version_id=?').run(v.id);
    }
    db.prepare('DELETE FROM policy_versions WHERE line_id=?').run(req.params.lineId);
    db.prepare('DELETE FROM policy_lines WHERE id=?').run(req.params.lineId);
  })();
  // 从向量库移除
  removeFromIndex(req.params.lineId).catch(() => {});
  // 清理上传文件目录
  try {
    const dir = path.join(config.root, 'data', 'uploads', line.library_id, req.params.lineId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* 忽略 */ }
  logger.audit({ action: 'force_delete', lineId: req.params.lineId, sessionId: req.sessionId });
  res.json({ ok: true });
});

// 删除已废止版本（物理销毁历史）或编辑中版本（工作区清理）；全部版本删除后自动删除整条政策线（级联）
policyRouter.delete('/policies/:lineId/versions/:versionId', (req, res) => {
  if (!getManagedLine(req, res, req.params.lineId)) return;
  const db = getDb();
  const v: any = db.prepare('SELECT status FROM policy_versions WHERE id=?').get(req.params.versionId);
  if (!v) return sendErr(req, res, 404, E('POLICY_VERSION_NOT_FOUND', '版本不存在', 'Version not found'));
  if (!['invalid', 'draft'].includes(v.status)) return sendErr(req, res, 400, E('POLICY_ONLY_INVALID_DRAFT_DELETE', '仅已废止或编辑中的版本可删除', 'Only revoked or editing versions can be deleted'));
  db.transaction(() => {
    db.prepare('DELETE FROM policy_chunks WHERE version_id=?').run(req.params.versionId);
    db.prepare('DELETE FROM policy_images WHERE version_id=?').run(req.params.versionId);
    db.prepare('DELETE FROM policy_versions WHERE id=?').run(req.params.versionId);
    // 级联：该 line 下无剩余版本 → 删除整条政策线
    const cnt: any = db.prepare('SELECT COUNT(*) AS c FROM policy_versions WHERE line_id=?').get(req.params.lineId);
    if (cnt.c === 0) {
      db.prepare('DELETE FROM policy_references WHERE from_line_id=? OR to_line_id=?').run(req.params.lineId, req.params.lineId);
      db.prepare('DELETE FROM policy_lines WHERE id=?').run(req.params.lineId);
    }
  })();
  // 方案 B：按版本删向量（该线其他已发布版本保留；draft 版本无向量，删除无副作用）
  removeVersionFromIndex(req.params.versionId).catch(() => {});
  logger.audit({ action: 'delete_version', lineId: req.params.lineId, versionId: req.params.versionId, sessionId: req.sessionId });
  res.json({ ok: true });
});

// ---------- 引用关系（双向自动链接） ----------
policyRouter.put('/policies/:lineId/refs', (req, res) => {
  if (!getManagedLine(req, res, req.params.lineId)) return;
  const toLineIds: string[] = req.body?.to_line_ids ?? [];
  const db = getDb();
  const cur: any = db.prepare('SELECT id FROM policy_lines WHERE id=?').get(req.params.lineId);
  if (!cur) return sendErr(req, res, 404, E('POLICY_LINE_NOT_FOUND', '政策线不存在', 'Policy line not found'));
  repo.setReferences(db, req.params.lineId, toLineIds);
  res.json(repo.getReferences(req.params.lineId));
});

policyRouter.get('/policies/:lineId/refs', (req, res) => {
  if (!getManagedLine(req, res, req.params.lineId)) return;
  res.json(repo.getReferences(req.params.lineId));
});