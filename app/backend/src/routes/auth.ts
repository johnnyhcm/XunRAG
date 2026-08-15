// 登录认证路由（S6 完整用户系统，2026-08-07，PRD §3.2）
// - POST /auth/login：工号+密码 → 校验（存在/启用/密码匹配）→ 发 token 存 sessions（有效期 7 天）
// - POST /auth/logout：吊销当前 token
// - POST /auth/change-password：自助改密（2026-08-09，ISSUE #44）——常规需当前密码；强制模式（must_change_password=1 且配置开启）豁免
// - 密码复杂度：≥8 位含大小写+数字（PRD §5.2；初始密码 Pass1234 满足）
import { Router } from 'express';
import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { getConfig } from '../services/config.js';
import { hashPassword, verifyPassword, INITIAL_PASSWORD } from '../services/password.js';
import { logger } from '../services/logger.js';
import { E, sendErr, type ErrDef } from '../services/errors.js';

export const authRouter = Router();

const SESSION_DAYS = 7;

// ===== 登录速率限制（P0-1，2026-08-13）——内存 Map，IP + 账号双维度，防爆破 =====
const loginFails = new Map<string, { count: number; lockUntil: number }>();
const MAX_LOGIN_FAILS = 5;                    // 连续失败 5 次
const LOGIN_LOCK_MS = 15 * 60 * 1000;         // 锁 15 分钟

function isLoginLocked(key: string): boolean {
  const rec = loginFails.get(key);
  if (!rec) return false;
  if (rec.lockUntil > Date.now()) return true;
  // 仅“锁定已过期”（lockUntil≠0 且 <now）才清理；lockUntil=0 表示未触发锁定、正在累积 count，不得误删
  if (rec.lockUntil !== 0) loginFails.delete(key);
  return false;
}
function recordLoginFail(key: string) {
  const rec = loginFails.get(key) ?? { count: 0, lockUntil: 0 };
  rec.count++;
  if (rec.count >= MAX_LOGIN_FAILS) { rec.lockUntil = Date.now() + LOGIN_LOCK_MS; rec.count = 0; }
  loginFails.set(key, rec);
  // 防内存无限增长：超上限清理过期项
  if (loginFails.size > 10000) {
    const now = Date.now();
    for (const [k, v] of loginFails) if (v.lockUntil < now) loginFails.delete(k);
  }
}
function clearLoginFails(key: string) { loginFails.delete(key); }
/** 管理员重置密码后解除该账号的登录锁定（2026-08-13）：重置密码语义=恢复登录能力，应清除临时锁定（仅限受信任的管理操作调用） */
export function clearLoginLock(employeeNo: string | null | undefined): void {
  if (!employeeNo) return;
  clearLoginFails(`emp:${String(employeeNo).trim().toLowerCase()}`);
}

// 密码复杂度校验（PRD §5.2：≥8 位含大小写+数字）；返回错误定义（本地化输出）
export function checkPasswordStrength(pw: string): ErrDef | null {
  if (pw.length < 8) return E('PASSWORD_TOO_SHORT', '密码至少 8 位', 'Password must be at least 8 characters');
  if (!/[a-z]/.test(pw)) return E('PASSWORD_NEED_LOWER', '密码需包含小写字母', 'Password must include lowercase letters');
  if (!/[A-Z]/.test(pw)) return E('PASSWORD_NEED_UPPER', '密码需包含大写字母', 'Password must include uppercase letters');
  if (!/\d/.test(pw)) return E('PASSWORD_NEED_DIGIT', '密码需包含数字', 'Password must include digits');
  return null;
}

function getUserByEmployeeNo(employeeNo: string): any {
  return getDb().prepare('SELECT * FROM users WHERE employee_no=?').get(String(employeeNo).trim());
}

// 登录
authRouter.post('/auth/login', (req, res) => {
  const { employee_no, password } = req.body ?? {};
  if (!employee_no?.trim() || !password) return sendErr(req, res, 400, E('AUTH_REQUIRED_FIELDS', '工号和密码必填', 'Employee number and password are required'));
  const empKey = `emp:${String(employee_no).trim().toLowerCase()}`;
  // 速率限制：账号维度（防爆破核心——锁单个账号，不受 IP 变化影响，也不连坐同 IP 的正常用户；内网 NAT 场景安全）
  if (isLoginLocked(empKey)) {
    logger.audit({ action: 'login_rate_limited', employeeNo: String(employee_no).trim(), sessionId: req.sessionId });
    return sendErr(req, res, 429, E('AUTH_RATE_LIMITED', '尝试次数过多，请稍后再试', 'Too many login attempts, please try again later'));
  }
  const u = getUserByEmployeeNo(employee_no);
  // 防探测：用户不存在/停用/密码错误 → 统一"工号或密码错误"（不泄露用户存在性）
  if (!u || u.status !== 'active' || !verifyPassword(String(password), u.password_hash)) {
    recordLoginFail(empKey);
    logger.audit({ action: 'login_failed', employeeNo: String(employee_no).trim(), sessionId: req.sessionId });
    return sendErr(req, res, 401, E('AUTH_INVALID_CREDENTIALS', '工号或密码错误', 'Invalid employee number or password'));
  }
  clearLoginFails(empKey);
  // 发 token
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
  getDb().prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, u.id, now.toISOString(), expiresAt);
  logger.audit({ action: 'login', userId: u.id, employeeNo: u.employee_no, sessionId: req.sessionId });
  res.json({ token, expires_at: expiresAt, user: publicUser(u) });
});

// 登出（吊销 token）
authRouter.post('/auth/logout', (req, res) => {
  const auth = req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : req.header('x-token')?.trim();
  if (token) getDb().prepare('DELETE FROM sessions WHERE token=?').run(token);
  logger.audit({ action: 'logout', userId: req.user?.id ?? null, sessionId: req.sessionId });
  res.json({ ok: true });
});

function publicUser(u: any) {
  return {
    id: u.id, employee_no: u.employee_no, name: u.name, email: u.email, department: u.department,
    position: u.position, region: u.region, contract_type: u.contract_type, level_type: u.level_type, role: u.role,
    language: u.language ?? 'zh-CN', // 2026-08-13：界面语言（BCP47，前端 /me 注入）
    mustChangePassword: u.must_change_password === 1, // 首次强制改密标志（2026-08-09）
  };
}

// 自助改密（2026-08-09，ISSUE #44）
// - 常规模式：需登录态 + currentPassword 正确 + 新密码满足复杂度且≠当前密码
// - 强制模式：must_change_password=1 且配置 force_change_on_first_login 开启 → 豁免 currentPassword（登录已验证身份）
// - 成功：更新 hash + 清零标志 + 吊销该用户其他设备全部 token（当前设备保持登录）
authRouter.post('/auth/change-password', (req, res) => {
  if (!req.user) return sendErr(req, res, 401, E('AUTH_NOT_LOGGED_IN', '未登录', 'Not logged in'));
  const db = getDb();
  const u: any = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!u) return sendErr(req, res, 401, E('USER_NOT_FOUND', '用户不存在', 'User not found'));
  const { currentPassword, newPassword } = req.body ?? {};
  const pw = String(newPassword ?? '');
  if (!pw) return sendErr(req, res, 400, E('PASSWORD_NEW_REQUIRED', '新密码必填', 'New password is required'));
  // 强制改密豁免判断：标志位 + 配置开启
  const force = u.must_change_password === 1 && getConfig('common.security.force_change_on_first_login', '0') === '1';
  if (!force) {
    if (!currentPassword) return sendErr(req, res, 400, E('PASSWORD_CURRENT_REQUIRED', '当前密码必填', 'Current password is required'));
    if (!verifyPassword(String(currentPassword), u.password_hash)) {
      logger.audit({ action: 'change_password_failed', userId: u.id, employeeNo: u.employee_no, sessionId: req.sessionId });
      return sendErr(req, res, 400, E('PASSWORD_CURRENT_WRONG', '当前密码不正确', 'Current password is incorrect'));
    }
  }
  // 新密码复杂度 + ≠ 当前密码（用 verify 判断新旧相同，避免明文比对）
  const err = checkPasswordStrength(pw);
  if (err) return sendErr(req, res, 400, err);
  if (verifyPassword(pw, u.password_hash)) return sendErr(req, res, 400, E('PASSWORD_SAME_AS_CURRENT', '新密码不能与当前密码相同', 'New password cannot be the same as the current password'));
  // 更新 + 清零标志
  db.prepare("UPDATE users SET password_hash=?, must_change_password=0, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?")
    .run(hashPassword(pw), u.id);
  // 吊销其他设备 token（当前 token 保留——当前会话为可信会话，方案 A）
  const auth = req.header('authorization') ?? '';
  const curToken = (auth.startsWith('Bearer ') ? auth.slice(7) : req.header('x-token'))?.trim();
  if (curToken) db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(u.id, curToken);
  logger.audit({ action: 'change_password', userId: u.id, employeeNo: u.employee_no, force: force ? 1 : 0, sessionId: req.sessionId });
  res.json({ ok: true, mustChangePassword: false });
});

export { INITIAL_PASSWORD, hashPassword };
