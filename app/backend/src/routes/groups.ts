// 用户组管理 API（S6 混合模型，2026-08-07，PRD §3.3）
// - 组类型：builtin（系统管理员/员工，内置）/ dynamic（动态条件）/ manual（手动）
// - 动态组：user_group_rules 条件（rule_no 分组 AND、组间 OR、字段 in 多值），成员实时算
// - 手动成员：user_group_members（动态+手动并存）；系统管理员组仅手动
// - 功能权限：本期组=管理功能集（政策库管理）；配置中心 S7
import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { newId } from '../db/repo.js';
import { logger } from '../services/logger.js';
import { E, sendErr } from '../services/errors.js';
import { requireAdmin, requireFn, isSystemAdmin } from '../services/permission.js';
import { previewGroupMembers } from '../services/permission.js';
import { getUserGroupIds } from '../services/permission.js';
import type { UserProfile } from '../services/permission.js';

export const groupsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

/** 编码自动识别（与 users.ts 同源，2026-08-11）：BOM→UTF-8/UTF-16；含替换符→GBK（Excel 另存兼容） */
function decodeCsv(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8').replace(/^\uFEFF/, '');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  const utf8 = buf.toString('utf8');
  return utf8.includes('\uFFFD') ? new TextDecoder('gbk').decode(buf) : utf8;
}
/** 极简 CSV 解析（支持双引号引用、引号内逗号/换行、CRLF，与 users.ts 同源） */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// ============ 选项字段（field_dicts + field_dict_options，2026-08-11 重构）============
// 值/名分离：value（稳定编码，匹配/存储/规则引用） + label（显示名，可改、可多语言）
// 生命周期：选项可增/改名/停用/删除（引用检查）；字段可新建（占 custom_1~10 槽位）/停用/删除（未引用）
// 内置字段 is_system=1（region/contract_type/level_type/department/position）：不可停用/删除（后端保护）
const FIELD_TYPES = ['option', 'multi', 'text'] as const;

/** 字段被规则/可见性引用数（group_rules.field + 政策库/文件 visible_rules JSON） */
function countFieldRefs(fieldKey: string): number {
  const db = getDb();
  let n = (db.prepare('SELECT COUNT(*) c FROM user_group_rules WHERE field=?').get(fieldKey) as any)?.c ?? 0;
  for (const tbl of ['policy_libraries', 'policy_lines']) {
    const rows = db.prepare(`SELECT visible_rules FROM ${tbl} WHERE visible_rules IS NOT NULL`).all() as any[];
    for (const r of rows) {
      try {
        const arr = JSON.parse(r.visible_rules);
        if (Array.isArray(arr) && arr.some((g: any) => (g?.conditions ?? []).some((c: any) => c?.field === fieldKey))) n++;
      } catch { /* ignore */ }
    }
  }
  return n;
}

/** 选项被用户数据/规则引用数 */
function countOptionRefs(fieldKey: string, value: string): number {
  const db = getDb();
  const u = db.prepare(`SELECT COUNT(*) c FROM users WHERE ${fieldKey}=?`).get(value) as any;
  let n = u?.c ?? 0;
  n += (db.prepare('SELECT COUNT(*) c FROM user_group_rules WHERE field=? AND allowed_values LIKE ?').get(fieldKey, `%${JSON.stringify(value).slice(1, -1)}%`) as any)?.c ?? 0;
  for (const tbl of ['policy_libraries', 'policy_lines']) {
    const rows = db.prepare(`SELECT visible_rules FROM ${tbl} WHERE visible_rules IS NOT NULL`).all() as any[];
    for (const r of rows) {
      try {
        const arr = JSON.parse(r.visible_rules);
        if (Array.isArray(arr) && arr.some((g: any) => (g?.conditions ?? []).some((c: any) => c?.field === fieldKey && Array.isArray(c?.values) && c.values.includes(value)))) n++;
      } catch { /* ignore */ }
    }
  }
  return n;
}

function loadField(key: string): any {
  return getDb().prepare('SELECT key, name, name_i18n, type, is_system, required, in_context, enabled, sort FROM field_dicts WHERE key=?').get(key);
}
function loadOptions(fieldKey: string): any[] {
  // 2026-08-11：启用在前、停用在后（各自按 sort）——停用选项不得插在启用前面
  return getDb().prepare('SELECT id, field_key, value, label, label_en, enabled, sort FROM field_dict_options WHERE field_key=? ORDER BY enabled DESC, sort').all(fieldKey);
}

// GET /api/field_dicts —— 全部字段（含选项）——规则编辑器/用户属性页共用
// 2026-08-11：返回 is_system/name_i18n/type + 选项对象数组（value/label 分离）；options 字符串数组字段废弃
const safeParse = (s: string | null | undefined): any => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
groupsRouter.get('/field_dicts', (_req, res) => {
  const db = getDb();
  const fields = db.prepare('SELECT key, name, name_i18n, type, is_system, required, in_context, enabled, sort FROM field_dicts ORDER BY sort').all() as any[];
  res.json({ fields: fields.map((f) => ({ ...f, name_i18n: safeParse(f.name_i18n), options: loadOptions(f.key) })) });
});

// POST /api/field_dicts —— 新建字段（2026-08-11：自动占用 custom_1~10 空闲槽位；或手填未占用槽位）
groupsRouter.post('/field_dicts', requireFn('config_mgmt'), (req, res) => {
  const db = getDb();
  const b = req.body ?? {};
  const name = String(b.name ?? '').trim();
  if (!name) return sendErr(req, res, 400, E('NAME_REQUIRED', '名称必填', 'Name is required'));
  let key = String(b.key ?? '').trim();
  if (key) {
    if (!/^custom_([1-9]|10)$/.test(key)) return sendErr(req, res, 400, E('FIELD_KEY_SLOT_ONLY', '字段 key 仅支持预置槽位 custom_1~custom_10', 'Field key must be a reserved slot custom_1~custom_10'));
    if (db.prepare('SELECT 1 x FROM field_dicts WHERE key=?').get(key)) return sendErr(req, res, 400, E('FIELD_SLOT_TAKEN', `槽位 ${key} 已被占用`, `Slot ${key} is already in use`));
  } else {
    for (let i = 1; i <= 10; i++) {
      if (!db.prepare('SELECT 1 x FROM field_dicts WHERE key=?').get(`custom_${i}`)) { key = `custom_${i}`; break; }
    }
    if (!key) return sendErr(req, res, 400, E('FIELD_SLOTS_FULL', '预留槽位已用满（10 个），如需更多请联系开发扩展', 'All 10 reserved slots are in use; contact development to extend'));
  }
  const type = FIELD_TYPES.includes(b.type) ? b.type : 'option';
  const nameI18n = b.name_i18n && typeof b.name_i18n === 'object' ? JSON.stringify(b.name_i18n) : null;
  db.prepare(`INSERT INTO field_dicts (key, name, name_i18n, type, is_system, enabled, sort, options, created_at, updated_at) VALUES (?,?,?,?,0,1,?,NULL,strftime('%Y-%m-%dT%H:%M:%SZ','now'),strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
    .run(key, name, nameI18n, type, Number(b.sort ?? 0));
  // 初次选项（可选）：[{value,label,label_en}] 或字符串数组（value=label）
  if (type !== 'text' && Array.isArray(b.options) && b.options.length) {
    const ins = db.prepare(`INSERT INTO field_dict_options (id, field_key, value, label, label_en, enabled, sort, created_at, updated_at) VALUES (?,?,?,?,?,1,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'),strftime('%Y-%m-%dT%H:%M:%SZ','now'))`);
    b.options.forEach((o: any, i: number) => {
      const v = typeof o === 'string' ? o.trim() : String(o?.value ?? '').trim();
      const l = typeof o === 'string' ? v : String(o?.label ?? v).trim();
      if (v && l) ins.run(newId(), key, v, l, typeof o === 'string' ? null : (o?.label_en ?? null), i);
    });
  }
  logger.audit({ action: 'create_field_dict', key, name, type, sessionId: req.sessionId });
  res.json({ ok: true, key });
});

// PUT /api/field_dicts/:key —— 编辑字段（name/name_i18n/type/enabled/sort；内置字段不可停用；type 切换校验）
groupsRouter.put('/field_dicts/:key', requireFn('config_mgmt'), (req, res) => {
  const db = getDb();
  const key = req.params.key;
  const cur = loadField(key);
  if (!cur) return sendErr(req, res, 404, E('FIELD_NOT_FOUND', '字段不存在', 'Field not found'));
  const b = req.body ?? {};
  if (b.enabled !== undefined && !b.enabled && cur.is_system) return sendErr(req, res, 400, E('FIELD_SYSTEM_NO_DISABLE', '系统内置字段不可停用（可停用单个选项）', 'System built-in fields cannot be disabled (individual options can be disabled)'));
  if (b.type !== undefined) {
    if (!FIELD_TYPES.includes(b.type)) return sendErr(req, res, 400, E('FIELD_TYPE_INVALID', '类型不合法', 'Invalid type'));
    if (b.type !== cur.type) {
      const cnt = (db.prepare('SELECT COUNT(*) c FROM field_dict_options WHERE field_key=?').get(key) as any)?.c ?? 0;
      if ((cur.type === 'text' || b.type === 'text') && cnt > 0) return sendErr(req, res, 400, E('FIELD_TEXT_OPTION_SWITCH', '文本与选项类型互切需先清空选项', 'Switching between text and option types requires clearing options first'));
    }
  }
  const sets: string[] = []; const vals: any[] = [];
  const upd = (f: string, v: any) => { if (v !== undefined) { sets.push(`${f}=?`); vals.push(v); } };
  if (b.name !== undefined) upd('name', String(b.name).trim());
  if (b.name_i18n !== undefined) upd('name_i18n', b.name_i18n && typeof b.name_i18n === 'object' ? JSON.stringify(b.name_i18n) : null);
  if (b.type !== undefined) upd('type', b.type);
  if (b.enabled !== undefined) upd('enabled', b.enabled ? 1 : 0);
  if (b.sort !== undefined) upd('sort', Number(b.sort));
  if (b.required !== undefined) upd('required', b.required ? 1 : 0); // 2026-08-11：业务级必填可配置
  if (b.in_context !== undefined) upd('in_context', b.in_context ? 1 : 0); // 2026-08-11：注入对话上下文可配置
  if (sets.length) {
    sets.push(`updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
    vals.push(key);
    db.prepare(`UPDATE field_dicts SET ${sets.join(',')} WHERE key=?`).run(...vals);
    logger.audit({ action: 'edit_field_dict', key, sessionId: req.sessionId });
  }
  res.json({ ok: true, key, field: { ...loadField(key), name_i18n: safeParse(loadField(key).name_i18n), options: loadOptions(key) } });
});

// DELETE /api/field_dicts/:key —— 删除字段（内置拒绝；规则/可见性引用拒绝；仅释放 custom_N 槽位，users 列保留）
groupsRouter.delete('/field_dicts/:key', requireFn('config_mgmt'), (req, res) => {
  const db = getDb();
  const key = req.params.key;
  const cur = loadField(key);
  if (!cur) return sendErr(req, res, 404, E('FIELD_NOT_FOUND', '字段不存在', 'Field not found'));
  if (cur.is_system) return sendErr(req, res, 400, E('FIELD_SYSTEM_NO_DELETE', '系统内置字段不可删除（可停用单个选项）', 'System built-in fields cannot be deleted (individual options can be disabled)'));
  const refs = countFieldRefs(key);
  if (refs > 0) return sendErr(req, res, 400, E('FIELD_REFERENCED', `字段被 ${refs} 处规则/可见性引用，不可删除（可停用字段）`, `Field is referenced by ${refs} rule(s)/visibility; cannot delete (field can be disabled)`));
  db.prepare('DELETE FROM field_dict_options WHERE field_key=?').run(key);
  db.prepare('DELETE FROM field_dicts WHERE key=?').run(key);
  logger.audit({ action: 'delete_field_dict', key, sessionId: req.sessionId });
  res.json({ ok: true });
});

// ---------- 选项 CRUD ----------

// POST /api/field_dicts/:key/options —— 新增选项（value 手填唯一；存量中文值可继续，新选项建议英文编码）
groupsRouter.post('/field_dicts/:key/options', requireFn('config_mgmt'), (req, res) => {
  const db = getDb();
  const key = req.params.key;
  const cur = loadField(key);
  if (!cur) return sendErr(req, res, 404, E('FIELD_NOT_FOUND', '字段不存在', 'Field not found'));
  if (cur.type === 'text') return sendErr(req, res, 400, E('FIELD_TEXT_NO_OPTIONS', '文本类型字段无选项', 'Text fields have no options'));
  const b = req.body ?? {};
  const value = String(b.value ?? '').trim();
  const label = String(b.label ?? '').trim();
  if (!value || !label) return sendErr(req, res, 400, E('FIELD_OPTION_VALUE_LABEL_REQUIRED', 'value 和显示名必填', 'value and display name are required'));
  if (db.prepare('SELECT 1 x FROM field_dict_options WHERE field_key=? AND value=?').get(key, value)) return sendErr(req, res, 400, E('FIELD_OPTION_VALUE_EXISTS', `选项 value 已存在：${value}`, `Option value already exists: ${value}`));
  const id = newId();
  db.prepare(`INSERT INTO field_dict_options (id, field_key, value, label, label_en, enabled, sort, created_at, updated_at) VALUES (?,?,?,?,?,1,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'),strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
    .run(id, key, value, label, b.label_en ? String(b.label_en).trim() : null, Number(b.sort ?? 0));
  logger.audit({ action: 'create_field_option', field_key: key, value, sessionId: req.sessionId });
  res.json({ ok: true, id });
});

// PUT /api/field_dicts/:key/options/:id —— 编辑选项（label/label_en/enabled/sort；value 不可改——改值=失配）
groupsRouter.put('/field_dicts/:key/options/:id', requireFn('config_mgmt'), (req, res) => {
  const db = getDb();
  const key = req.params.key;
  const cur = db.prepare('SELECT * FROM field_dict_options WHERE id=? AND field_key=?').get(req.params.id, key) as any;
  if (!cur) return sendErr(req, res, 404, E('FIELD_OPTION_NOT_FOUND', '选项不存在', 'Option not found'));
  const b = req.body ?? {};
  const sets: string[] = []; const vals: any[] = [];
  const upd = (f: string, v: any) => { if (v !== undefined) { sets.push(`${f}=?`); vals.push(v); } };
  if (b.label !== undefined) upd('label', String(b.label).trim());
  if (b.label_en !== undefined) upd('label_en', b.label_en ? String(b.label_en).trim() : null);
  if (b.enabled !== undefined) upd('enabled', b.enabled ? 1 : 0);
  if (b.sort !== undefined) upd('sort', Number(b.sort));
  if (sets.length) {
    sets.push(`updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
    vals.push(cur.id);
    db.prepare(`UPDATE field_dict_options SET ${sets.join(',')} WHERE id=?`).run(...vals);
    logger.audit({ action: 'edit_field_option', field_key: key, option_id: cur.id, sessionId: req.sessionId });
  }
  res.json({ ok: true });
});

// POST /api/field_dicts/:key/options/sort —— 批量重排（2026-08-11：body {ids:[新顺序完整列表]}，事务重写 sort=0..n-1，幂等）
// 前端上移/下移/未来拖拽共用；日常微调用按钮，几百个整体排序走 CSV（sort 列）
groupsRouter.post('/field_dicts/:key/options/sort', requireFn('config_mgmt'), (req, res) => {
  const key = req.params.key;
  const cur = loadField(key);
  if (!cur) return sendErr(req, res, 404, E('FIELD_NOT_FOUND', '字段不存在', 'Field not found'));
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) return sendErr(req, res, 400, E('FIELD_IDS_REQUIRED', 'ids 必填', 'ids is required'));
  const opts = loadOptions(key);
  const idSet = new Set(opts.map((o) => o.id));
  if (ids.some((id: string) => !idSet.has(id))) return sendErr(req, res, 400, E('FIELD_IDS_NOT_OWNED', 'ids 含不属于该字段的选项', 'ids contains options not belonging to this field'));
  if (ids.length !== opts.length) return sendErr(req, res, 400, E('FIELD_IDS_INCOMPLETE', 'ids 必须包含该字段全部选项', 'ids must include all options of this field'));
  const db = getDb();
  const tx = db.transaction(() => {
    const upd = db.prepare(`UPDATE field_dict_options SET sort=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`);
    ids.forEach((id: string, i: number) => upd.run(i, id));
  });
  tx();
  logger.audit({ action: 'sort_field_options', field_key: key, sessionId: req.sessionId });
  res.json({ ok: true });
});

// DELETE /api/field_dicts/:key/options/:id —— 删除选项（用户数据/规则引用则拒绝，提示停用）
groupsRouter.delete('/field_dicts/:key/options/:id', requireFn('config_mgmt'), (req, res) => {
  const db = getDb();
  const key = req.params.key;
  const cur = db.prepare('SELECT * FROM field_dict_options WHERE id=? AND field_key=?').get(req.params.id, key) as any;
  if (!cur) return sendErr(req, res, 404, E('FIELD_OPTION_NOT_FOUND', '选项不存在', 'Option not found'));
  const refs = countOptionRefs(cur.field_key, cur.value);
  if (refs > 0) return sendErr(req, res, 400, E('FIELD_OPTION_REFERENCED', `选项「${cur.label}」被 ${refs} 处用户数据/规则引用，不可删除（可停用：存量数据保留，新数据不可选）`, `Option ${cur.label} is referenced by ${refs} user data/rule(s); cannot delete (can disable: existing data kept, new data not selectable)`));
  db.prepare('DELETE FROM field_dict_options WHERE id=?').run(cur.id);
  logger.audit({ action: 'delete_field_option', field_key: key, option_id: cur.id, sessionId: req.sessionId });
  res.json({ ok: true });
});

// POST /api/field_dicts/:key/options/csv —— CSV 批量维护（2026-08-11，全量清单语义：新增/更新；未列出默认保留可勾选停用）
// 两段式：dryRun=1 校验+预览（新增/更新/停用/未列出），再 dryRun=0 执行；编码自动识别（BOM/UTF-16/GBK，Excel 另存即用）
// CSV 列：value,label,label_en,enabled,sort（value 已存在可任意格式=兼容存量中文；新建按编码规范）
groupsRouter.post('/field_dicts/:key/options/csv', requireFn('config_mgmt'), upload.single('file'), (req, res) => {
  const db = getDb();
  const key = req.params.key;
  const cur = loadField(key);
  if (!cur) return sendErr(req, res, 404, E('FIELD_NOT_FOUND', '字段不存在', 'Field not found'));
  if (cur.type === 'text') return sendErr(req, res, 400, E('FIELD_TEXT_NO_OPTIONS', '文本类型字段无选项', 'Text fields have no options'));
  if (!req.file) return sendErr(req, res, 400, E('USER_CSV_REQUIRED', '请上传 CSV 文件', 'Please upload a CSV file'));
  const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';
  const text = decodeCsv(req.file.buffer);
  const grid = parseCsv(text);
  if (grid.length < 2) return sendErr(req, res, 400, E('USER_CSV_EMPTY', '文件为空或缺少数据行', 'File is empty or missing data rows'));
  const header = grid[0].map((h) => h.trim().replace(/\*+$/, '').trim());
  const col = (name: string) => header.indexOf(name);
  if (col('value') < 0 || col('label') < 0) return sendErr(req, res, 400, E('FIELD_CSV_MISSING_COLS', 'CSV 缺少必填列：value、label（参考模板）', 'CSV is missing required columns: value, label (see template)'));
  const ci = { value: col('value'), label: col('label'), label_en: col('label_en'), enabled: col('enabled'), sort: col('sort') };
  // 逐行解析 + 校验（任一错整批拒绝）
  const existing = new Map(loadOptions(key).map((o) => [o.value, o]));
  const errors: string[] = [];
  const rows: { value: string; label: string; label_en: string | null; enabled: number; sort: number }[] = [];
  grid.slice(1).filter((r) => r.some((c) => c.trim())).forEach((r, i) => {
    const lineNo = i + 2;
    const value = (r[ci.value] ?? '').trim();
    const label = (r[ci.label] ?? '').trim();
    if (!value) return errors.push(`第 ${lineNo} 行：value 必填`);
    if (!label) return errors.push(`第 ${lineNo} 行：显示名必填`);
    if (rows.some((x) => x.value === value)) return errors.push(`第 ${lineNo} 行：value 与文件内重复（${value}）`);
    const en = ci.label_en >= 0 ? (r[ci.label_en] ?? '').trim() : '';
    const enabled = ci.enabled >= 0 ? (String(r[ci.enabled]).trim() === '0' || String(r[ci.enabled]).trim().toLowerCase() === '停用' ? 0 : 1) : 1;
    const sort = ci.sort >= 0 && r[ci.sort] && !isNaN(Number(r[ci.sort])) ? Number(r[ci.sort]) : 0;
    rows.push({ value, label, label_en: en || null, enabled, sort });
  });
  if (errors.length) return sendErr(req, res, 400, E('GROUPS_CSV_INVALID', `CSV 校验失败（${errors.length} 处，已全部拒绝）：\n${errors.slice(0, 20).join('\n')}`, `CSV validation failed (${errors.length} issue(s), all rejected):\n${errors.slice(0, 20).join('\n')}`));
  // 变更计算：新增 / 更新 / 未列出（默认保留，可选停用）
  const now = rows.map((r) => r.value);
  const added = rows.filter((r) => !existing.has(r.value));
  const updated = rows.filter((r) => {
    const e = existing.get(r.value);
    if (!e) return false;
    return e.label !== r.label || (e.label_en ?? '') !== (r.label_en ?? '') || e.enabled !== r.enabled || e.sort !== r.sort;
  });
  const unlisted = [...existing.values()].filter((o) => !now.includes(o.value));
  if (dryRun) {
    return res.json({ preview: { added: added.length, updated: updated.length, unlisted: unlisted.map((o) => o.label) } });
  }
  // 执行：新增 + 更新；未列出默认保留（前端可选择传 disable_unlisted=1 停用）
  const ins = db.prepare(`INSERT INTO field_dict_options (id, field_key, value, label, label_en, enabled, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'),strftime('%Y-%m-%dT%H:%M:%SZ','now'))`);
  const updOpt = db.prepare(`UPDATE field_dict_options SET label=?, label_en=?, enabled=?, sort=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE field_key=? AND value=?`);
  for (const r of rows) {
    if (existing.has(r.value)) updOpt.run(r.label, r.label_en, r.enabled, r.sort, key, r.value);
    else ins.run(newId(), key, r.value, r.label, r.label_en, r.enabled, r.sort);
  }
  if (req.query?.disableUnlisted === '1' || req.query?.disableUnlisted === 'true') {
    for (const o of unlisted) db.prepare(`UPDATE field_dict_options SET enabled=0, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(o.id);
  }
  logger.audit({ action: 'csv_update_field_options', field_key: key, added: added.length, updated: updated.length, disabled_unlisted: unlisted.length, sessionId: req.sessionId });
  res.json({ ok: true, stats: { added: added.length, updated: updated.length, disabledUnlisted: unlisted.length } });
});


// 权限角色管理：按功能权限（role_mgmt；系统管理员天然通过）——2026-08-08 从 requireAdmin 放开
// （PRD §3.3：权限角色管理为系统级功能，业务角色可分勾；多角色并集）
// 安全护栏：非系统管理员持 role_mgmt 时，内置角色（system_admin/employee）仍不可改（防提权）——各写端点单独校验
groupsRouter.use('/groups', requireFn('role_mgmt')); // 限定 /groups 路径，避免 use 无路径拦截全部 /api

groupsRouter.get('/groups', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT id, name, type, description, enabled, sort, function_ids, managed_library_ids FROM user_groups ORDER BY sort, name').all() as any[];
  const out = rows.map((g) => {
    const rules = db.prepare('SELECT rule_no, field, operator, allowed_values FROM user_group_rules WHERE group_id=? ORDER BY rule_no').all(g.id) as any[];
    const manual = db.prepare(`SELECT m.type, u.id, u.name, u.employee_no, u.department, u.position FROM user_group_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=? ORDER BY u.name`).all(g.id) as any[];
    return {
      ...g,
      function_ids: safeParse((g as any).function_ids),
      managed_library_ids: safeParse((g as any).managed_library_ids),
      rules: rules.map((r) => ({ rule_no: r.rule_no, field: r.field, operator: r.operator ?? 'in', values: safeParse(r.allowed_values) })),
      include_members: manual.filter((m) => m.type === 'include').map((u) => ({ id: u.id, name: u.name, employee_no: u.employee_no, department: u.department, position: u.position })),
      exclude_members: manual.filter((m) => m.type === 'exclude').map((u) => ({ id: u.id, name: u.name, employee_no: u.employee_no, department: u.department, position: u.position })),
      members: computeGroupMembers(g.id), // 完整成员（规则自动 + 包含 − 排除），列表直观展示
    };
  });
  res.json({ groups: out });
});

// 新建组
groupsRouter.post('/groups', (req, res) => {
  const db = getDb();
  const b = req.body ?? {};
  const name = String(b.name ?? '').trim();
  const type = ['dynamic', 'manual'].includes(b.type) ? b.type : 'manual';
  if (!name) return sendErr(req, res, 400, E('GROUP_NAME_REQUIRED', '组名必填', 'Group name is required'));
  const id = newId();
  db.prepare(`INSERT INTO user_groups (id, name, type, description, enabled, sort, created_at, updated_at) VALUES (?,?,?,?,1,?,?,?)`)
    .run(id, name, type, b.description ?? null, (b.sort ?? 10), new Date().toISOString(), new Date().toISOString());
  logger.audit({ action: 'create_group', groupId: id, name, type, sessionId: req.sessionId });
  res.json({ ok: true, id });
});

// 编辑组（改名/描述/停用；内置组 type 不可改）
// 安全护栏（2026-08-08）：内置角色（system_admin/employee）的功能/范围/启用不可被非系统管理员修改（防提权）
groupsRouter.put('/groups/:id', (req, res) => {
  const db = getDb();
  const g = db.prepare('SELECT id, type FROM user_groups WHERE id=?').get(req.params.id) as any;
  if (!g) return sendErr(req, res, 404, E('GROUP_NOT_FOUND', '组不存在', 'Group not found'));
  const b = req.body ?? {};
  if (g.type === 'builtin' && !isSystemAdmin(req.user ?? null)) {
    const dangerous = ['enabled', 'function_ids', 'managed_library_ids'].some((k) => b[k] !== undefined);
    if (dangerous) return sendErr(req, res, 403, E('GROUP_BUILTIN_LOCKED', '内置角色的功能/范围/启用仅系统管理员可修改', 'Built-in role functions/scope/enabled can only be modified by system administrators'));
  }
  const sets: string[] = []; const vals: any[] = [];
  if (b.name !== undefined) { sets.push('name=?'); vals.push(String(b.name).trim()); }
  if (b.description !== undefined) { sets.push('description=?'); vals.push(b.description ?? null); }
  if (b.enabled !== undefined) { sets.push('enabled=?'); vals.push(b.enabled ? 1 : 0); }
  // 方案 B：功能勾选 + 管理范围（勾选库，含 ALL）
  if (Array.isArray(b.function_ids)) { sets.push('function_ids=?'); vals.push(JSON.stringify(b.function_ids)); }
  if (Array.isArray(b.managed_library_ids)) { sets.push('managed_library_ids=?'); vals.push(JSON.stringify(b.managed_library_ids)); }
  if (sets.length) {
    sets.push('updated_at=?'); vals.push(new Date().toISOString(), req.params.id);
    db.prepare(`UPDATE user_groups SET ${sets.join(',')} WHERE id=?`).run(...vals);
    logger.audit({ action: 'edit_group', groupId: req.params.id, sessionId: req.sessionId });
  }
  res.json({ ok: true });
});

// 删除组（内置组不可删；同时清理规则/成员/库管理组引用）
groupsRouter.delete('/groups/:id', (req, res) => {
  const db = getDb();
  const g = db.prepare('SELECT id, type FROM user_groups WHERE id=?').get(req.params.id) as any;
  if (!g) return sendErr(req, res, 404, E('GROUP_NOT_FOUND', '组不存在', 'Group not found'));
  if (g.type === 'builtin') return sendErr(req, res, 400, E('GROUP_BUILTIN_UNDELETABLE', '内置组不可删除', 'Built-in groups cannot be deleted'));
  // 清理库管理组引用（admin_group_ids 移除该组）
  const libs = db.prepare('SELECT id, admin_group_ids FROM policy_libraries WHERE admin_group_ids IS NOT NULL').all() as { id: string; admin_group_ids: string }[];
  for (const l of libs) {
    try {
      const arr = JSON.parse(l.admin_group_ids);
      if (Array.isArray(arr) && arr.includes(req.params.id)) {
        db.prepare('UPDATE policy_libraries SET admin_group_ids=? WHERE id=?').run(JSON.stringify(arr.filter((x) => x !== req.params.id)), l.id);
      }
    } catch { /* 忽略损坏 JSON */ }
  }
  db.prepare('DELETE FROM user_group_rules WHERE group_id=?').run(req.params.id);
  db.prepare('DELETE FROM user_group_members WHERE group_id=?').run(req.params.id);
  db.prepare('DELETE FROM user_groups WHERE id=?').run(req.params.id);
  logger.audit({ action: 'delete_group', groupId: req.params.id, sessionId: req.sessionId });
  res.json({ ok: true });
});

// 动态条件保存：[{rule_no, field, values[]}] —— rule_no 相同=AND 组，不同=OR
// 安全护栏（2026-08-08）：内置角色无规则区（员工全员/系统管理员仅手动），非系统管理员不可写
// 系统管理员组禁规则（安全红线：仅手动加入）；employee 组规则会改变全员成员判定，仅系统管理员可配
groupsRouter.put('/groups/:id/rules', (req, res) => {
  const db = getDb();
  const g = db.prepare('SELECT id, type FROM user_groups WHERE id=?').get(req.params.id) as any;
  if (!g) return sendErr(req, res, 404, E('GROUP_NOT_FOUND', '组不存在', 'Group not found'));
  if (g.type === 'builtin' && !isSystemAdmin(req.user ?? null)) {
    return sendErr(req, res, 403, E('GROUP_BUILTIN_RULES_LOCKED', '内置角色的规则仅系统管理员可配置', 'Built-in role rules can only be configured by system administrators'));
  }
  const rules = Array.isArray(req.body?.rules) ? req.body.rules : [];
  db.prepare('DELETE FROM user_group_rules WHERE group_id=?').run(req.params.id);
  for (const r of rules) {
    if (!r.field || !Array.isArray(r.values) || !r.values.length) continue;
    const op = r.operator === 'not_in' ? 'not_in' : 'in';
    db.prepare('INSERT INTO user_group_rules (id, group_id, rule_no, field, operator, allowed_values, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(newId(), req.params.id, r.rule_no ?? 0, String(r.field), op, JSON.stringify(r.values.map(String)), new Date().toISOString());
  }
  logger.audit({ action: 'edit_group_rules', groupId: req.params.id, ruleCount: rules.length, sessionId: req.sessionId });
  res.json({ ok: true, ruleCount: rules.length });
});

// 手动成员：加入 / 移除（系统管理员组仅手动，可在此操作）
// 安全护栏（2026-08-08）：非系统管理员不可增删系统管理员组成员（授予/收回系统管理员的唯一入口）
groupsRouter.post('/groups/:id/members/:userId', (req, res) => {
  const db = getDb();
  const g = db.prepare('SELECT id, type FROM user_groups WHERE id=?').get(req.params.id) as any;
  if (!g) return sendErr(req, res, 404, E('GROUP_NOT_FOUND', '组不存在', 'Group not found'));
  if (req.params.id === 'system_admin' && !isSystemAdmin(req.user ?? null)) {
    return sendErr(req, res, 403, E('GROUP_ADMIN_MEMBERS_LOCKED', '系统管理员组的成员仅系统管理员可管理（安全红线）', 'System administrator group members can only be managed by system administrators (security red line)'));
  }
  const u = db.prepare('SELECT id FROM users WHERE id=?').get(req.params.userId);
  if (!u) return sendErr(req, res, 404, E('USER_NOT_FOUND', '用户不存在', 'User not found'));
  const type = ['include', 'exclude'].includes(req.body?.type) ? req.body.type : 'include';
  // 同一用户不能在 include 和 exclude 同时存在（互斥）
  db.prepare("DELETE FROM user_group_members WHERE group_id=? AND user_id=?").run(req.params.id, req.params.userId);
  db.prepare("INSERT OR IGNORE INTO user_group_members (group_id, user_id, type, created_at) VALUES (?,?,?,?)").run(req.params.id, req.params.userId, type, new Date().toISOString());
  logger.audit({ action: 'group_add_member', groupId: req.params.id, userId: req.params.userId, type, sessionId: req.sessionId });
  res.json({ ok: true, type });
});
groupsRouter.delete('/groups/:id/members/:userId', (req, res) => {
  const db = getDb();
  if (req.params.id === 'system_admin' && !isSystemAdmin(req.user ?? null)) {
    return sendErr(req, res, 403, E('GROUP_ADMIN_MEMBERS_LOCKED', '系统管理员组的成员仅系统管理员可管理（安全红线）', 'System administrator group members can only be managed by system administrators (security red line)'));
  }
  if (req.params.id === 'system_admin' && req.params.userId === 'admin') {
    return sendErr(req, res, 400, E('GROUP_ADMIN_SAFEGUARD', '不能移除 admin 的系统管理员身份（防锁死）', 'The admin role cannot be removed from the admin account (anti-lockout)'));
  }
  db.prepare('DELETE FROM user_group_members WHERE group_id=? AND user_id=?').run(req.params.id, req.params.userId);
  logger.audit({ action: 'group_remove_member', groupId: req.params.id, userId: req.params.userId, sessionId: req.sessionId });
  res.json({ ok: true });
});

// 组当前成员（动态组实时算 + 手动成员合并）
function computeGroupMembers(groupId: string): { id: string; name: string; employee_no: string | null; department: string | null; position: string | null }[] {
  const db = getDb();
  const users = db.prepare('SELECT id, name, employee_no, department, position, region, contract_type, level_type FROM users WHERE status=?').all('active') as any[];
  const members: any[] = [];
  for (const u of users) {
    const profile = { id: u.id, name: u.name, department: u.department, position: u.position, region: u.region, hire_date: null, contract_type: u.contract_type, level_type: u.level_type, role: 'employee' };
    if (getUserGroupIds(profile as UserProfile).includes(groupId)) members.push({ id: u.id, name: u.name, employee_no: u.employee_no, department: u.department, position: u.position });
  }
  return members;
}

groupsRouter.get('/groups/:id/members', (req, res) => {
  const db = getDb();
  const g = db.prepare('SELECT id, type FROM user_groups WHERE id=?').get(req.params.id) as any;
  if (!g) return sendErr(req, res, 404, E('GROUP_NOT_FOUND', '组不存在', 'Group not found'));
  res.json({ members: computeGroupMembers(req.params.id) });
});

export { isSystemAdmin };

// 字段字典（2026-08-11 起移至上方新实现：值/名分离 + 选项独立表 + CSV 维护）

// 成员预览（2026-08-08）：编辑权限角色时按草稿规则计算成员名单（不保存）——"查看最新规则下的成员名单"预览
groupsRouter.post('/groups/preview-members', requireFn('role_mgmt'), (req, res) => {
  const rules = Array.isArray(req.body?.rules) ? req.body.rules : [];
  const include = Array.isArray(req.body?.include) ? req.body.include.map(String) : [];
  const exclude = Array.isArray(req.body?.exclude) ? req.body.exclude.map(String) : [];
  res.json({ members: previewGroupMembers(rules, include, exclude) });
});
