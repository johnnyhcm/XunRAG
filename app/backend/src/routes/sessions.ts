// /api/sessions —— 历史会话列表 + 详情（含会话过期判断，PRD §4.4.7；时长配置化 2026-08-06）
import { Router, type Request, type Response } from 'express';
import { getDb } from '../db/index.js';
import { getNumber } from '../services/config.js';

export const sessionsRouter = Router();

interface SessionRow {
  id: string;
  firstQuestion: string | null;
  lastMessageAt: string;
  messageCount: number;
  expired: 0 | 1;
}
function parseSqlTs(ts: string): number {
  if (!ts) return 0;
  const s = ts.includes('Z') ? ts : ts.replace(' ', 'T') + 'Z';
  return new Date(s).getTime();
}

// GET /sessions —— 按 session 分组（取首条 user 问题作摘要、最后消息时间、是否过期）
// 2026-08-08 修复：身份来源统一用 req.user（sessionMiddleware 已解析 token/X-User-Id）——
//   此前直接读 X-User-Id header（默认 admin），与 chat.ts 的 req.user 不一致 → 登录用户历史列表显示 admin 会话、点开无消息
sessionsRouter.get('/sessions', (req: Request, res: Response) => {
  const db = getDb();
  const userId = req.user?.id ?? 'anonymous';
  const rows = db.prepare(
    `SELECT c.id AS session_id,
       (SELECT question FROM messages m WHERE m.session_id=c.id AND m.user_id=? ORDER BY m.created_at ASC LIMIT 1) AS first_question,
       (SELECT created_at FROM messages m WHERE m.session_id=c.id AND m.user_id=? ORDER BY m.created_at DESC LIMIT 1) AS last_at,
       (SELECT COUNT(*) FROM messages m WHERE m.session_id=c.id AND m.user_id=?) AS message_count
     FROM conversations c
     WHERE EXISTS (SELECT 1 FROM messages m WHERE m.session_id=c.id AND m.user_id=?)
     ORDER BY last_at DESC`,
  ).all(userId, userId, userId, userId) as any[];
  const now = Date.now();
  const expireMs = getNumber('common.session.expire_hours', 24) * 3600 * 1000;
  const out = rows.map((r) => {
    const lastTs = parseSqlTs(r.last_at);
    const expired = lastTs && now - lastTs > expireMs ? 1 : 0;
    return {
      session_id: r.session_id,
      first_question: r.first_question ?? '(空)',
      last_at: r.last_at,
      message_count: r.message_count,
      expired,
    };
  });
  res.json({ sessions: out });
});