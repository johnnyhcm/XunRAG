// 后端错误码 + 本地化输出（2026-08-13，PRD §5.3 i18n 决策② / DISSCUSION 2026-08-13）
// 原则：
// - 错误码（code）稳定、机器可读、后端语言无关 —— 日志/前端映射/测试断言用
// - 人读文案（error）按请求 Accept-Language 输出（zh-CN 默认；en-US 返回英文）—— 用户永远看到自己语言
// - 未注册码回退请求语言默认（中文）与英文原文（供开发者）
// 用法：sendErr(req, res, 401, E('AUTH_INVALID_CREDENTIALS', '工号或密码错误', 'Invalid employee number or password'))
// 迁移节奏：增量（auth → users → policy → …），新端点直接用，旧端点逐步替换
import type { Request, Response } from 'express';

export interface ErrDef { code: string; zh: string; en: string }

/** 注册并返回错误定义（模块级注册表，幂等） */
const defs = new Map<string, ErrDef>();
export function E(code: string, zh: string, en: string): ErrDef {
  const d: ErrDef = { code, zh, en };
  defs.set(code, d);
  return d;
}

/** 按请求语言取人读文案（Accept-Language 以 en 开头 → 英文，其余中文） */
export function errMsg(req: Request, def: ErrDef): string {
  const lang = String(req.headers['accept-language'] ?? '').toLowerCase();
  return lang.startsWith('en') ? def.en : def.zh;
}

/** 统一错误响应：{ error: <本地化文案>, code: <稳定码> } */
export function sendErr(req: Request, res: Response, status: number, def: ErrDef): void {
  res.status(status).json({ error: errMsg(req, def), code: def.code });
}

/** 非 Express 场景（services 抛错等）：按语言返回文案 */
export function msgFor(def: ErrDef, lang?: string): string {
  return (lang ?? '').toLowerCase().startsWith('en') ? def.en : def.zh;
}
