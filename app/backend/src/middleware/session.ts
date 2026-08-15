// 会话 + 身份中间件（PRD §3.1 / TECH.md §3.4 / S4 方案 A / S6 完整用户系统 2026-08-07）
// - X-Session-Id：会话标识（前端 localStorage UUID）
// - 身份来源优先级（S6）：
//   ① Authorization: Bearer <token>（登录态，sessions 表校验，未过期）——真实身份，前端不再手选；有 token 即信任 token，不降级（防绕过）
//   ② 无 token：AUTH_MODE=demo（默认）时 X-User-Id 降级兜底（开发/测试/演示身份切换）；无 X-User-Id → 匿名
//   ③ AUTH_MODE=production：无 token → 不设 req.user（匿名零可见，必须登录）
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import { config } from '../config.js';

declare module 'express-serve-static-core' {
  interface Request {
    sessionId: string;
    /** 当前用户（S6：登录 token 优先；demo 模式 X-User-Id 降级；production 无 token 为 undefined） */
    user?: {
      id: string;
      name: string;
      employee_no: string | null;
      department: string | null;
      position: string | null;
      region: string | null;
      hire_date: string | null;
      contract_type: string | null;
      level_type: string | null;
      role: string | null;
    };
  }
}

const USER_COLS = 'id, name, employee_no, department, position, region, hire_date, contract_type, level_type, role, language';

export function sessionMiddleware(req: Request, _res: Response, next: NextFunction): void {
  // 会话
  const header = req.header('X-Session-Id');
  req.sessionId = header && header.trim() ? header.trim() : randomUUID();

  try {
    // ① 登录 token 优先（sessions 表校验，未过期）——有 token 即信任 token，不降级到 X-User-Id（防绕过）
    const auth = req.header('authorization') ?? '';
    const token = (auth.startsWith('Bearer ') ? auth.slice(7) : req.header('x-token'))?.trim();
    if (token) {
      const s = getDb().prepare('SELECT user_id FROM sessions WHERE token=? AND expires_at > ?').get(token, new Date().toISOString()) as { user_id: string } | undefined;
      if (s) {
        const row = getDb().prepare(`SELECT ${USER_COLS} FROM users WHERE id=? AND status='active'`).get(s.user_id) as any;
        if (row) {
          req.user = {
            id: row.id, name: row.name, employee_no: row.employee_no, department: row.department, position: row.position,
            region: row.region, hire_date: row.hire_date, contract_type: row.contract_type,
            level_type: row.level_type, role: row.role,
          };
        }
      }
      // token 无效/过期 → 不设 req.user（匿名零可见；防探测不提示无效原因）
    } else if (config.authMode === 'demo') {
      // ② demo 模式显式 X-User-Id 降级（开发/测试/演示身份切换）；无 X-User-Id → 匿名（不兜底 admin）
      const raw = req.header('X-User-Id')?.trim();
      if (raw) {
        const row = getDb()
          .prepare(`SELECT ${USER_COLS} FROM users WHERE id = ? AND status = ?`)
          .get(raw, 'active') as any;
        if (row) {
          req.user = {
            id: row.id, name: row.name, employee_no: row.employee_no, department: row.department, position: row.position,
            region: row.region, hire_date: row.hire_date, contract_type: row.contract_type,
            level_type: row.level_type, role: row.role,
          };
        }
        // raw 指定但无效（不存在/停用）→ 保持 req.user 未定义：权限判定零可见、检索装不存在（防越权/防探测，ISSUE #36）
      }
      // 无 X-User-Id → 匿名（不兜底 admin）
    }
    // ③ production 无 token → 匿名
  } catch {
    // DB 未就绪时跳过（测试/启动期）
  }

  // 诊断日志（2026-08-08）：关键路径记录实际身份来源——排查"正常登录但匿名拒答"
  if (req.path.startsWith('/api/chat') || req.path.startsWith('/api/sessions') || req.path === '/api/me') {
    const auth = req.header('authorization') ?? '';
    const hasToken = auth.startsWith('Bearer ') || !!req.header('x-token');
    console.log(`[auth-diag] ${req.method} ${req.path} 带token=${hasToken} X-User-Id=${req.header('X-User-Id') ?? '无'} → user=${req.user?.id ?? '匿名'}`);
  }
  next();
}
