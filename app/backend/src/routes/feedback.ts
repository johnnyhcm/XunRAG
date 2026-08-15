// /api/feedback —— 满意度反馈（PRD §4.4.5）
// 绑定 message_id + session_id；不强制
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { newId } from '../db/repo.js';
import { logger } from '../services/logger.js';
import { E, sendErr } from '../services/errors.js';

export const feedbackRouter = Router();

feedbackRouter.post('/feedback', (req, res) => {
  const { message_id, value, reason } = req.body ?? {};
  if (!message_id || !value) return sendErr(req, res, 400, E('FEEDBACK_REQUIRED', 'message_id 与 value 必填', 'message_id and value are required'));
  if (!['up', 'down'].includes(value)) return sendErr(req, res, 400, E('FEEDBACK_VALUE_INVALID', 'value 仅 up/down', 'value must be up or down'));
  const db = getDb();
  // P1 归属校验（2026-08-13）：只能给自己的消息投反馈（防越权污染他人反馈）
  const msg = db.prepare('SELECT user_id FROM messages WHERE id=?').get(message_id) as { user_id: string } | undefined;
  if (msg && msg.user_id !== (req.user?.id ?? 'anonymous')) {
    return sendErr(req, res, 403, E('FEEDBACK_FORBIDDEN', '只能对自己的消息进行反馈', 'You can only give feedback on your own messages'));
  }
  db.prepare(
    `INSERT INTO feedbacks (id, message_id, session_id, value, reason) VALUES (?,?,?,?,?)`,
  ).run(newId(), message_id, req.sessionId, value, reason ?? null);
  // 审计日志（PRD §4.5.2：反馈入 audit 日志；reason 含具体原因文字，可追溯）
  logger.audit({ action: 'feedback', userId: req.user?.id ?? null, messageId: message_id, value, reason: reason ?? null, sessionId: req.sessionId });
  res.json({ ok: true });
});

// GET /feedback/:messageId —— 查某条消息已有反馈（同样校验归属，防越权读取）
feedbackRouter.get('/feedback/:messageId', (req, res) => {
  const msg = getDb().prepare('SELECT user_id FROM messages WHERE id=?').get(req.params.messageId) as { user_id: string } | undefined;
  if (msg && msg.user_id !== (req.user?.id ?? 'anonymous')) {
    return sendErr(req, res, 403, E('FEEDBACK_FORBIDDEN', '只能查看自己的消息反馈', 'You can only view feedback on your own messages'));
  }
  const row = getDb().prepare('SELECT value, reason FROM feedbacks WHERE message_id=? ORDER BY created_at DESC LIMIT 1').get(req.params.messageId) as any;
  res.json({ feedback: row ?? null });
});