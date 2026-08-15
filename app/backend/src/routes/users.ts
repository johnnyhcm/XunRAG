// 用户管理 API（S6 前置最小版，2026-08-07，PRD §4.1.5）
// - 工号 employee_no 可改（业务字段，唯一校验，排除自身）；主键 id=系统 UUID 不可改（URL/引用稳定）
// - 无物理删除：停用/启用；admin 禁停用；被 topic_routes 引用的联系人禁停用
// - 编辑即写 DB，权限判定实时读取属性不缓存（C2 决策）——改属性后下次请求立即生效
import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db/index.js';
import { newId } from '../db/repo.js';
import { logger } from '../services/logger.js';
import { requireAdmin, requireFn, requireAnyMgmt, isSystemAdmin, isSystemAdminMember, hasPerm, canManageLibrary, getUserGroupIds } from '../services/permission.js';
import { hashPassword, INITIAL_PASSWORD } from '../services/password.js';
import { clearLoginLock } from './auth.js';
import { getConfig } from '../services/config.js';
import { config } from '../config.js';
import { E, sendErr } from '../services/errors.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export const usersRouter = Router();

// GET /api/me —— 当前用户 + 权限（前端按权限渲染入口/菜单，PRD §3.3 ④；后端校验不受影响）
// forcePasswordChange（2026-08-09）：must_change_password=1 且配置 force_change_on_first_login 开启 → 前端强制改密（只认此字段，不感知配置）
usersRouter.get('/me', (req, res) => {
  const user = req.user ?? null;
  const db = getDb();
  let mustChange = false;
  if (user) {
    const row = db.prepare('SELECT must_change_password FROM users WHERE id=?').get(user.id) as any;
    mustChange = row?.must_change_password === 1;
  }
  const forcePasswordChange = mustChange && getConfig('common.security.force_change_on_first_login', '0') === '1';
  const fns = new Set<string>();
  const managed = new Set<string>();
  for (const rid of getUserGroupIds(user)) {
    const r = db.prepare('SELECT function_ids, managed_library_ids FROM user_groups WHERE id=? AND enabled=1').get(rid) as { function_ids: string | null; managed_library_ids: string | null } | undefined;
    try { for (const f of r?.function_ids ? JSON.parse(r.function_ids) : []) fns.add(String(f)); } catch { /* 损坏忽略 */ }
    try { for (const l of r?.managed_library_ids ? JSON.parse(r.managed_library_ids) : []) managed.add(String(l)); } catch { /* 损坏忽略 */ }
  }
  if (isSystemAdmin(user)) { // 系统管理员全功能 + 全部库
    for (const f of ['policy_library_mgmt', 'policy_mgmt', 'user_mgmt', 'role_mgmt', 'config_mgmt', 'stats_view']) fns.add(f);
    managed.add('ALL');
  }
  res.json({ user: user ? { ...user, language: (user as any).language ?? 'zh-CN', mustChangePassword: mustChange } : null, isSystemAdmin: isSystemAdmin(user), functions: [...fns], managed_library_ids: [...managed], forcePasswordChange,
    authMode: config.authMode }); // 2026-08-11：前端按需显示 demo 测试切换器（production 隐藏）
});

// 可编辑字段白名单（id/timezone/open_id/source_type 等系统字段不暴露）
const EDITABLE = ['employee_no', 'name', 'department', 'position', 'email', 'phone', 'region', 'contract_type', 'level_type', 'role', 'status',
  'custom_1', 'custom_2', 'custom_3', 'custom_4', 'custom_5', 'custom_6', 'custom_7', 'custom_8', 'custom_9', 'custom_10']; // 2026-08-11：预留自定义字段
// 2026-08-11 修复（ISSUE #56 补全）：可空文本字段——null/undefined/空串统一归一 NULL（防 String(null)='null' 存脏值；
// 必填字段（region/contract_type/level_type required=1）会被必填校验先拦截，不走到写入）
const NULLABLE_FIELDS = new Set(['email', 'phone', 'position', 'department', 'region', 'contract_type', 'level_type',
  'custom_1', 'custom_2', 'custom_3', 'custom_4', 'custom_5', 'custom_6', 'custom_7', 'custom_8', 'custom_9', 'custom_10']);

// GET /api/users?search=&status=&sortBy=&sortOrder= —— 列表（搜索 + 状态过滤 + 列头排序）
// 2026-08-08：任一管理功能可读（权限角色编辑页的成员选择器也用此端点；系统管理员天然通过）
// 2026-08-11：排序参数——列名白名单防注入；默认工号升序；NULL 值始终排最后（枚举/文本列）
const SORT_COLS = new Set(['employee_no', 'name', 'department', 'region', 'contract_type', 'level_type', 'status']);
usersRouter.get('/users', requireAnyMgmt(), (req, res) => {
  const db = getDb();
  const search = String(req.query.search ?? '').trim();
  const status = String(req.query.status ?? '').trim();
  const sortBy = SORT_COLS.has(String(req.query.sortBy ?? '')) ? String(req.query.sortBy) : 'employee_no';
  const sortOrder = String(req.query.sortOrder ?? '').trim().toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const params: any[] = [];
  let sql = 'SELECT id, employee_no, name, department, position, email, phone, region, contract_type, level_type, role, status, created_at, updated_at FROM users WHERE 1=1';
  if (search) {
    sql += ' AND (name LIKE ? OR employee_no LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (status === 'active' || status === 'inactive') {
    sql += ' AND status=?';
    params.push(status);
  }
  sql += ` ORDER BY CASE WHEN ${sortBy} IS NULL THEN 1 ELSE 0 END, ${sortBy} ${sortOrder}`;
  try {
    const rows = db.prepare(sql).all(...params);
    res.json({ users: rows });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// POST /api/users —— 新建（工号唯一、姓名/工号必填；需用户管理功能）
usersRouter.post('/users', requireFn('user_mgmt'), (req, res) => {
  const db = getDb();
  const b = req.body ?? {};
  const employeeNo = String(b.employee_no ?? '').trim();
  const name = String(b.name ?? '').trim();
  if (!employeeNo || !name) return sendErr(req, res, 400, E('USER_NAME_EMPLOYEE_REQUIRED', '工号和姓名必填', 'Employee number and name are required'));
  // 2026-08-11：业务级必填校验（field_dicts.required=1 的字段，新建时必须填写；工号/姓名系统必填已在上方）
  const reqFields = db.prepare('SELECT key, name FROM field_dicts WHERE required=1 AND enabled=1').all() as any[];
  for (const f of reqFields) {
    const v = b[f.key];
    if (v === null || v === undefined || String(v).trim() === '') return sendErr(req, res, 400, E('USER_FIELD_REQUIRED', `「${f.name}」为必填项`, `"${f.name}" is required`));
  }
  const dup = db.prepare('SELECT id FROM users WHERE employee_no=?').get(employeeNo);
  if (dup) return sendErr(req, res, 400, E('USER_EMPLOYEE_EXISTS', `工号 ${employeeNo} 已存在`, `Employee number ${employeeNo} already exists`));
  const id = newId();
  const fields = ['id', ...EDITABLE, 'password_hash', 'must_change_password', 'created_at', 'updated_at'];
  const vals: any[] = [id];
  for (const f of EDITABLE) {
    // 2026-08-11 修复（ISSUE #56）：可选字段（email/phone）空串 → NULL（UNIQUE 约束允许多个 NULL、不允许多个空串）
    if (b[f] === undefined) vals.push(f === 'status' ? 'active' : null);
    // 2026-08-11 修复（ISSUE #56 补全）：可空文本字段 null/undefined/空串 → NULL（防 String(null)='null'）
    else if (NULLABLE_FIELDS.has(f)) { const s = b[f] == null ? '' : String(b[f]).trim(); vals.push(s || null); }
    else vals.push(String(b[f]));
  }
  vals.push(hashPassword(INITIAL_PASSWORD)); // 新建用户初始密码统一 Pass1234（S6 完整用户系统 2026-08-07）
  vals.push(1); // 新建置强制改密标志（2026-08-09：配置开启时首次登录强制改密）
  vals.push(new Date().toISOString(), new Date().toISOString());
  try {
    db.prepare(`INSERT INTO users (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...vals);
    logger.audit({ action: 'create_user', userId: id, employeeNo, name, sessionId: req.sessionId });
    res.json({ ok: true, id });
  } catch (e: any) {
    // 2026-08-11：UNIQUE 冲突给友好提示（重复邮箱/工号是常见操作错误，不暴露 SQLite 原始错误）
    const msg = String(e?.message ?? e);
    if (msg.includes('UNIQUE constraint failed: users.email')) return sendErr(req, res, 400, E('USER_EMAIL_EXISTS', '该邮箱已被其他用户使用', 'This email is already in use by another user'));
    if (msg.includes('UNIQUE constraint failed: users.employee_no')) return sendErr(req, res, 400, E('USER_EMPLOYEE_EXISTS', '该工号已被其他用户使用', 'This employee number is already in use'));
    res.status(500).json({ error: msg });
  }
});

// PUT /api/users/:id —— 编辑（需用户管理功能）
// 安全护栏（2026-08-08）：系统管理员组成员不可被非系统管理员停用（防锁死/防提权）
usersRouter.put('/users/:id', requireFn('user_mgmt'), (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const u: any = db.prepare('SELECT id, employee_no, role, status FROM users WHERE id=?').get(id);
  if (!u) return sendErr(req, res, 404, E('USER_NOT_FOUND', '用户不存在', 'User not found'));
  const b = req.body ?? {};
  const nextStatus = b.status ?? u.status;
  if (!isSystemAdmin(req.user ?? null) && isSystemAdminMember(id) && nextStatus === 'inactive') {
    return sendErr(req, res, 403, E('USER_ADMIN_CANNOT_DISABLE', '系统管理员不可被停用（仅系统管理员可操作）', 'System administrators cannot be disabled (system admins only)'));
  }
  if (u.id === 'admin' && nextStatus === 'inactive') return sendErr(req, res, 400, E('USER_ADMIN_FIXED', 'admin 不可停用', 'The admin account cannot be disabled'));
  if (u.id !== 'admin' && nextStatus === 'inactive') {
    const ref = db.prepare('SELECT id FROM topic_routes WHERE contact_user_id=?').get(id);
    if (ref) return sendErr(req, res, 400, E('USER_CONTACT_CANNOT_DISABLE', '该用户是转人工联系人，不可停用', 'This user is a human-assistance contact and cannot be disabled'));
  }
  if (b.employee_no !== undefined && String(b.employee_no).trim() !== u.employee_no) {
    const dup = db.prepare('SELECT id FROM users WHERE employee_no=? AND id<>?').get(String(b.employee_no).trim(), id);
    if (dup) return sendErr(req, res, 400, E('USER_EMPLOYEE_EXISTS', `工号 ${b.employee_no} 已存在`, `Employee number ${b.employee_no} already exists`));
  }
  // 2026-08-11：业务级必填——传入且为空的必填字段拒绝（未传=保留原值不校验；清空必填字段需先配置为选填）
  const reqFields = db.prepare('SELECT key, name FROM field_dicts WHERE required=1 AND enabled=1').all() as any[];
  for (const f of reqFields) {
    if (b[f.key] !== undefined && (b[f.key] === null || String(b[f.key]).trim() === '')) {
      return sendErr(req, res, 400, E('USER_FIELD_REQUIRED', `「${f.name}」为必填项`, `"${f.name}" is required`));
    }
  }
  const sets = EDITABLE.filter((f) => b[f] !== undefined).map((f) => `${f}=?`);
  if (!sets.length) return res.json({ ok: true });
  const vals: any[] = EDITABLE.filter((f) => b[f] !== undefined).map((f) => {
    // 2026-08-11 修复（ISSUE #56 补全）：可空文本字段 null/undefined/空串 → NULL（防 String(null)='null' 存脏值）
    if (f === 'employee_no') return String(b[f]).trim();
    if (NULLABLE_FIELDS.has(f)) { const s = b[f] == null ? '' : String(b[f]).trim(); return s || null; }
    return String(b[f]);
  });
  try {
    db.prepare(`UPDATE users SET ${sets.join(',')}, updated_at=? WHERE id=?`).run(...vals, new Date().toISOString(), id);
    logger.audit({ action: 'edit_user', userId: id, fields: sets.join(','), sessionId: req.sessionId });
    res.json({ ok: true });
  } catch (e: any) {
    // 2026-08-11：UNIQUE 冲突给友好提示（重复邮箱常见，不暴露 SQLite 原始错误）
    const msg = String(e?.message ?? e);
    if (msg.includes('UNIQUE constraint failed: users.email')) return sendErr(req, res, 400, E('USER_EMAIL_EXISTS', '该邮箱已被其他用户使用', 'This email is already in use by another user'));
    if (msg.includes('UNIQUE constraint failed: users.employee_no')) return sendErr(req, res, 400, E('USER_EMPLOYEE_EXISTS', '该工号已被其他用户使用', 'This employee number is already in use'));
    res.status(500).json({ error: msg });
  }
});

// 重置密码（S6，2026-08-07）：管理员重置为初始密码 Pass1234（测试环境统一；强确认在前端）
// 注意：必须注册在 /users/:id/:action 之前（否则被 action 路由吞掉，2026-08-07）
// 安全护栏（2026-08-08）：系统管理员组成员不可被非系统管理员重置密码
usersRouter.post('/users/:id/reset-password', requireFn('user_mgmt'), (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT id, employee_no FROM users WHERE id=?').get(req.params.id) as { id: string; employee_no: string | null };
  if (!u) return sendErr(req, res, 404, E('USER_NOT_FOUND', '用户不存在', 'User not found'));
  if (!isSystemAdmin(req.user ?? null) && isSystemAdminMember(req.params.id)) {
    return sendErr(req, res, 403, E('USER_ADMIN_PASSWORD_LOCKED', '系统管理员的密码不可被重置（仅系统管理员可操作）', 'System administrator passwords cannot be reset (system admins only)'));
  }
  db.prepare(`UPDATE users SET password_hash=?, must_change_password=1, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(hashPassword(INITIAL_PASSWORD), req.params.id);
  clearLoginLock(u.employee_no); // 重置密码=恢复登录能力，同时解除该账号的登录锁定（2026-08-13）
  logger.audit({ action: 'reset_password', userId: req.params.id, sessionId: req.sessionId });
  res.json({ ok: true });
});

// POST /api/users/:id/deactivate | /activate —— 停用/启用（需用户管理功能）
// 安全护栏（2026-08-08）：系统管理员组成员不可被非系统管理员停用
usersRouter.post('/users/:id/:action', requireFn('user_mgmt'), (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const action = req.params.action;
  if (action !== 'deactivate' && action !== 'activate') return sendErr(req, res, 400, E('USER_BAD_ACTION', 'action 须为 deactivate/activate', 'action must be deactivate or activate'));
  const u: any = db.prepare('SELECT id, status FROM users WHERE id=?').get(id);
  if (!u) return sendErr(req, res, 404, E('USER_NOT_FOUND', '用户不存在', 'User not found'));
  if (action === 'deactivate') {
    if (!isSystemAdmin(req.user ?? null) && isSystemAdminMember(id)) {
      return sendErr(req, res, 403, E('USER_ADMIN_CANNOT_DISABLE', '系统管理员不可被停用（仅系统管理员可操作）', 'System administrators cannot be disabled (system admins only)'));
    }
    if (id === 'admin') return sendErr(req, res, 400, E('USER_ADMIN_FIXED', 'admin 不可停用', 'The admin account cannot be disabled'));
    const ref = db.prepare('SELECT id FROM topic_routes WHERE contact_user_id=?').get(id);
    if (ref) return sendErr(req, res, 400, E('USER_CONTACT_CANNOT_DISABLE', '该用户是转人工联系人，不可停用', 'This user is a human-assistance contact and cannot be disabled'));
  }
  db.prepare("UPDATE users SET status=?, updated_at=? WHERE id=?").run(action === 'deactivate' ? 'inactive' : 'active', new Date().toISOString(), id);
  logger.audit({ action: action === 'deactivate' ? 'deactivate_user' : 'activate_user', userId: id, sessionId: req.sessionId });
  res.json({ ok: true, status: action === 'deactivate' ? 'inactive' : 'active' });
});

// DELETE /api/users/:id —— 条件删除（非系统管理员/非联系人/非组成员；2026-08-07）
// 安全护栏（2026-08-08）：系统管理员组成员不可被非系统管理员删除
usersRouter.delete('/users/:id', requireFn('user_mgmt'), (req, res) => {
  const db = getDb();
  const u: any = db.prepare('SELECT id, name FROM users WHERE id=?').get(req.params.id);
  if (!u) return sendErr(req, res, 404, E('USER_NOT_FOUND', '用户不存在', 'User not found'));
  if (!isSystemAdmin(req.user ?? null) && isSystemAdminMember(u.id)) {
    return sendErr(req, res, 403, E('USER_ADMIN_CANNOT_DELETE', '系统管理员不可被删除（仅系统管理员可操作）', 'System administrators cannot be deleted (system admins only)'));
  }
  if (u.id === 'admin') return sendErr(req, res, 400, E('USER_ADMIN_FIXED', '系统管理员 admin 不可删除', 'The admin account cannot be deleted'));
  const ref = db.prepare('SELECT id FROM topic_routes WHERE contact_user_id=?').get(u.id);
  if (ref) return sendErr(req, res, 400, E('USER_CONTACT_CANNOT_DELETE', '该用户是转人工联系人，不可删除（可停用）', 'This user is a human-assistance contact and cannot be deleted (can be disabled)'));
  const inGroup = db.prepare('SELECT group_id FROM user_group_members WHERE user_id=?').get(u.id);
  if (inGroup) return sendErr(req, res, 400, E('USER_IN_GROUP', '该用户是用户组成员，请先移出后再删除', 'This user is a member of a user group; remove them first'));
  // 方案 A（2026-08-07）：有对话历史不可删（历史是审计资产，删除后归属无法追溯）——只能停用
  const hasHistory = db.prepare('SELECT 1 x FROM messages WHERE user_id=? LIMIT 1').get(u.id);
  if (hasHistory) return sendErr(req, res, 400, E('USER_HAS_HISTORY', '该用户有对话历史，不可删除（可停用）', 'This user has conversation history and cannot be deleted (can be disabled)'));
  // 级联清理组成员关系 + 登录会话（保险；2026-08-07 sessions 外键）
  db.prepare('DELETE FROM user_group_members WHERE user_id=?').run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  logger.audit({ action: 'delete_user', userId: req.params.id, name: u.name, sessionId: req.sessionId });
  res.json({ ok: true });
});
// 重置密码（S6，2026-08-07）：管理员重置为初始密码 Pass1234（测试环境统一；强确认在前端）
usersRouter.post('/users/:id/reset-password', requireFn('user_mgmt'), (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT id, employee_no FROM users WHERE id=?').get(req.params.id) as { id: string; employee_no: string | null };
  if (!u) return sendErr(req, res, 404, E('USER_NOT_FOUND', '用户不存在', 'User not found'));
  if (!isSystemAdmin(req.user ?? null) && isSystemAdminMember(req.params.id)) {
    return sendErr(req, res, 403, E('USER_ADMIN_PASSWORD_LOCKED', '系统管理员的密码不可被重置（仅系统管理员可操作）', 'System administrator passwords cannot be reset (system admins only)'));
  }
  db.prepare(`UPDATE users SET password_hash=?, must_change_password=1, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(hashPassword(INITIAL_PASSWORD), req.params.id);
  clearLoginLock(u.employee_no); // 重置密码=恢复登录能力，同时解除该账号的登录锁定（2026-08-13）
  logger.audit({ action: 'reset_password', userId: req.params.id, sessionId: req.sessionId });
  res.json({ ok: true });
});


// ============ CSV 批量导入/导出/模板（2026-08-07 完整版，PRD §4.1.5） ============
// schema 驱动：user_import_fields 元数据表决定列头/校验/写入；
// 2026-08-11：合并预留自定义字段（field_dicts 启用的 custom_1~10）——label=字段显示名，dict_key=field（选项存 field_dict_options）
interface ImportFieldMeta { field: string; label: string; type: string; required: number; unique_key: number; dict_key: string | null }
function importFields(db: ReturnType<typeof getDb>): ImportFieldMeta[] {
  const base = db.prepare('SELECT field, label, type, required, unique_key, dict_key FROM user_import_fields ORDER BY sort').all() as ImportFieldMeta[];
  // 2026-08-11：required 统一读 field_dicts（业务级必填可配置）——覆盖内置字段（region 等）+ 预留字段
  const dicts = db.prepare('SELECT key, required FROM field_dicts WHERE enabled=1').all() as any[];
  const reqOf = new Map(dicts.map((d) => [d.key, d.required]));
  for (const m of base) if (reqOf.has(m.field)) m.required = reqOf.get(m.field) ?? 0;
  const used = new Set(base.map((m) => m.field));
  const customs = db.prepare("SELECT key AS field, name AS label, type, key AS dict_key FROM field_dicts WHERE enabled=1 AND key LIKE 'custom\\_%' ESCAPE '\\' ORDER BY sort").all() as any[];
  for (const c of customs) if (!used.has(c.field)) base.push({ field: c.field, label: c.label, type: c.type, required: reqOf.get(c.field) ?? 0, unique_key: 0, dict_key: c.dict_key });
  return base;
}

/** 编码自动识别：BOM→UTF-8/UTF-16；UTF-8 解码含替换符→GBK（Excel 另存兼容，闭环第一步保障） */
function decodeCsv(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8').replace(/^\uFEFF/, '');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  const utf8 = buf.toString('utf8');
  return utf8.includes('\uFFFD') ? new TextDecoder('gbk').decode(buf) : utf8;
}

/** 极简 CSV 解析（支持双引号引用、引号内逗号/换行、CRLF） */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
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

/** 导出单元格转义（含逗号/引号/换行时加引号） */
function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ImportStat { created: number; updated: number; activated: number; deactivated: number; skipped: { row: number; reason: string }[] }
/** 校验 + 四层匹配（id 有值存在→更新 / id 有值不存在→跳过 / id 空工号存在→更新 / 工号无→新增）；dryRun 只校验不写库 */
function runImport(db: ReturnType<typeof getDb>, rows: Record<string, string>[], dryRun: boolean): ImportStat {
  const metas = importFields(db);
  // 2026-08-11：选项字典改从 field_dict_options 读（value 稳定编码；旧 field_dicts.options 已废弃）
  const dicts = new Map<string, Set<string>>();
  for (const m of metas) if ((m.type === 'option' || m.type === 'multi') && m.dict_key) {
    const opts = db.prepare('SELECT value FROM field_dict_options WHERE field_key=? AND enabled=1').all(m.dict_key) as any[];
    dicts.set(m.dict_key, new Set(opts.map((o) => o.value)));
  }
  const optMetas = metas.filter((m) => (m.type === 'option' || m.type === 'multi') && m.dict_key);
  const stat: ImportStat = { created: 0, updated: 0, activated: 0, deactivated: 0, skipped: [] };
  // 字段归一：null/undefined/空 → ''；字面 'null'（数据导出工具常见）→ ''（2026-08-07，防"邮箱 null 格式非法"误报）
  const str = (v: unknown) => {
    const s = v == null ? '' : String(v).trim();
    return s.toLowerCase() === 'null' ? '' : s;
  };
  // 选项字段校验：值不在字典 → 跳过整行（2026-08-07 决策，不静默改数据）
  // multi（2026-08-11）：CSV 逗号分隔 → 拆分数组逐个校验 → 存 JSON；更新时：CSV 值 == 库中现值（未变更）→ 放行
  const pickOption = (r: Record<string, string>, rowNo: number, target?: any): Record<string, string | null> | null => {
    const vals: Record<string, string | null> = {};
    for (const m of optMetas) {
      const raw = str(r[m.field]);
      if (!raw) { vals[m.field] = null; continue; }
      if (m.type === 'multi') {
        if (target && JSON.stringify(raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)) === JSON.stringify((() => { try { return JSON.parse(target[m.field] ?? '[]'); } catch { return []; } })())) { vals[m.field] = target[m.field]; continue; }
        const parts = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        const bad = parts.find((p) => !dicts.get(m.dict_key!)?.has(p));
        if (bad) { stat.skipped.push({ row: rowNo, reason: `「${m.label}」的值「${bad}」不在选项字典内（多选用逗号分隔）` }); return null; }
        vals[m.field] = JSON.stringify(parts);
      } else {
        if (target && target[m.field] === raw) { vals[m.field] = raw; continue; }
        if (!dicts.get(m.dict_key!)?.has(raw)) { stat.skipped.push({ row: rowNo, reason: `「${m.label}」的值「${raw}」不在选项字典内` }); return null; }
        vals[m.field] = raw;
      }
    }
    return vals;
  };
  const optCols = optMetas.map((m) => m.field);
  const tx = db.transaction(() => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]; const rowNo = i + 2; // 含表头
      const id = str(r.id); const emp = str(r.employee_no); const name = str(r.name); const email = str(r.email) || null;
      let target: any = null;
      if (id) target = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      else if (emp) target = db.prepare('SELECT * FROM users WHERE employee_no=?').get(emp);
      if (!target) {
        // ---- 新增（默认启用，初始密码 Pass1234）----
        if (id) { stat.skipped.push({ row: rowNo, reason: `用户ID ${id} 不存在` }); continue; }
        if (!emp || !name) { stat.skipped.push({ row: rowNo, reason: '工号/姓名必填' }); continue; }
        // 2026-08-11：业务级必填（field_dicts.required=1）——新增时必须填写
        const reqMiss = metas.find((m) => m.required && m.field !== 'employee_no' && m.field !== 'name' && !str(r[m.field]));
        if (reqMiss) { stat.skipped.push({ row: rowNo, reason: `「${reqMiss.label}」为必填项` }); continue; }
        if (db.prepare('SELECT 1 FROM users WHERE employee_no=?').get(emp)) { stat.skipped.push({ row: rowNo, reason: `工号 ${emp} 已存在` }); continue; }
        if (email && db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) { stat.skipped.push({ row: rowNo, reason: `邮箱 ${email} 已存在` }); continue; }
        if (email && !EMAIL_RE.test(email)) { stat.skipped.push({ row: rowNo, reason: `邮箱 ${email} 格式非法` }); continue; }
        const vals = pickOption(r, rowNo); if (!vals) continue;
        const status = str(r.status) || 'active';
        if (!['active', 'inactive'].includes(status)) { stat.skipped.push({ row: rowNo, reason: `状态 ${status} 非法` }); continue; }
        if (!dryRun) {
          const cols = ['id', 'employee_no', 'name', 'email', 'status', 'password_hash', 'must_change_password', 'source_type', ...optCols];
          const args = [newId(), emp, name, email, status, hashPassword(INITIAL_PASSWORD), 1, 'csv', ...optCols.map((c) => vals[c] ?? null)];
          db.prepare(`INSERT INTO users (${cols.join(',')}, created_at, updated_at) VALUES (${cols.map(() => '?').join(',')},strftime('%Y-%m-%dT%H:%M:%SZ','now'),strftime('%Y-%m-%dT%H:%M:%SZ','now'))`).run(...args);
        }
        stat.created++;
      } else {
        // ---- 更新（某列留空=不更新；password_hash 永不覆盖；停用用户也可更新）----
        if (emp && emp !== target.employee_no && db.prepare('SELECT 1 FROM users WHERE employee_no=? AND id<>?').get(emp, target.id)) { stat.skipped.push({ row: rowNo, reason: `工号 ${emp} 已被其他用户占用` }); continue; }
        if (email && email !== target.email && db.prepare('SELECT 1 FROM users WHERE email=? AND id<>?').get(email, target.id)) { stat.skipped.push({ row: rowNo, reason: `邮箱 ${email} 已被其他用户占用` }); continue; }
        if (email && !EMAIL_RE.test(email)) { stat.skipped.push({ row: rowNo, reason: `邮箱 ${email} 格式非法` }); continue; }
        const vals = pickOption(r, rowNo, target); if (!vals) continue;
        // 状态：空=不改；active=启用（2026-08-07 用户确认）；inactive=停用
        let status: string | null = null;
        const rs = str(r.status);
        if (rs) { if (!['active', 'inactive'].includes(rs)) { stat.skipped.push({ row: rowNo, reason: `状态 ${rs} 非法` }); continue; } status = rs; }
        if (!dryRun) {
          const sets: string[] = []; const args: any[] = [];
          const upd: [string, string][] = [
            ['employee_no', emp], ['name', name], ['email', email ?? ''],
            ...optCols.map((c) => [c, (vals[c] ?? '') as string] as [string, string]),
          ];
          for (const [f, v] of upd) if (v) { sets.push(`${f}=?`); args.push(v); }
          if (status) { sets.push('status=?'); args.push(status); }
          if (sets.length) { args.push(target.id); db.prepare(`UPDATE users SET ${sets.join(',')}, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(...args); }
        }
        if (status === 'active') stat.activated++;
        else if (status === 'inactive') stat.deactivated++;
        stat.updated++;
      }
    }
  });
  tx();
  return stat;
}

// 模板下载：列头 + 必填 * 标记，无数据行（解析时剥 *）
usersRouter.get('/users/template', requireFn('user_mgmt'), (_req, res) => {
  const metas = importFields(getDb());
  const header = metas.map((m) => m.label + (m.required ? '*' : ''));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=user_template.csv');
  res.send('\uFEFF' + header.join(',') + '\n');
});

// 全量导出（含停用，含 id 列）——闭环起点：导出→线下修改→回导
usersRouter.get('/users/export', requireFn('user_mgmt'), (_req, res) => {
  const db = getDb();
  const metas = importFields(db);
  const lines = [metas.map((m) => m.label).join(',')];
  const rows = db.prepare('SELECT * FROM users ORDER BY employee_no').all() as any[];
  for (const u of rows) lines.push(metas.map((m) => csvCell(String(u[m.field] ?? ''))).join(','));
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=users_${date}.csv`);
  res.send('\uFEFF' + lines.join('\n'));
});

// CSV 导入（multipart file 或 JSON rows 双通道；dryRun=1 预览不写库）
usersRouter.post('/users/import', requireFn('user_mgmt'), upload.single('file'), (req, res) => {
  const db = getDb();
  const dryRun = req.body?.dryRun === '1' || req.body?.dryRun === true;
  let rows: Record<string, string>[] | null = null;
  let unknownCols: string[] = [];
  if (req.file) {
    const text = decodeCsv(req.file.buffer);
    const grid = parseCsv(text);
    if (!grid.length) return sendErr(req, res, 400, E('FIELD_CSV_EMPTY', '文件为空或无可解析数据', 'File is empty or contains no parseable data'));
    const metas = importFields(db);
    const labelToField = new Map(metas.map((m) => [m.label, m.field]));
    const header = grid[0].map((h) => h.trim().replace(/\*+$/, '').trim());
    const colField = header.map((h) => labelToField.get(h) ?? null);
    unknownCols = header.filter((h) => !labelToField.has(h));
    const missing = metas.filter((m) => m.required && !header.includes(m.label));
    if (missing.length) return sendErr(req, res, 400, E('USER_CSV_MISSING_COLS', `缺少必填列：${missing.map((m) => m.label).join('、')}`, `Missing required columns: ${missing.map((m) => m.label).join('、')}`));
    rows = grid.slice(1).filter((g) => g.some((c) => c.trim())).map((line) => {
      const o: Record<string, string> = {};
      line.forEach((v, ci) => { const f = colField[ci]; if (f) o[f] = v; });
      return o;
    });
  } else if (Array.isArray(req.body?.rows)) {
    rows = (req.body.rows as any[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? '' : String(v)])));
  }
  if (!rows || !rows.length) return sendErr(req, res, 400, E('USER_NO_IMPORT', '无导入数据', 'No import data'));
  if (rows.length > 50000) return sendErr(req, res, 400, E('USER_IMPORT_LIMIT', `单次导入不能超过 5 万行（当前 ${rows.length} 行）`, `Single import cannot exceed 50,000 rows (currently ${rows.length} rows)`));
  let stat: ImportStat;
  try { stat = runImport(db, rows, dryRun); }
  catch (e: any) { return sendErr(req, res, 500, E('USER_IMPORT_FAILED', `导入失败：${e?.message ?? e}`, `Import failed: ${e?.message ?? e}`)); }
  if (!dryRun) logger.audit({ action: 'import_users', file: req.file?.originalname ?? null, created: stat.created, updated: stat.updated, activated: stat.activated, deactivated: stat.deactivated, skipped: stat.skipped.length, sessionId: req.sessionId });
  res.json({ dryRun, total: rows.length, unknownCols, ...stat });
});
