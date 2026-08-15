// 认证抽象层 —— 接口预留，空实现占位（PRD §3.1 / §4.1.3）
// S4 补：用户名密码 + 密码复杂度 + 会话管理
// 设计目标：S4 插上登录即可用，历史数据（session 记录的指标）不返工
import type { Request, Response, NextFunction } from 'express';

/**
 * S1 空实现：统一 admin 身份直通，不做鉴权。
 * S4 实现后：校验登录态 → 解析 user_id → req.userId。
 */
export function authMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  // TODO(S4): 校验会话令牌，填充 req.userId
  // 本期无登录，直接放行（统一 admin）
  next();
}

/** 占位：S4 登录路由注册点 */
export function mountAuthRoutes(_router: unknown): void {
  // TODO(S4): POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me
}