// JSON Lines 日志（PRD §4.5.2）：logs/chat / logs/audit / logs/app 按天分文件
// - chat：每次问答完整记录（含引用、指标）
// - audit：管理操作（上传/发布/失效/删除/反馈）
// - app：系统运行（启动/错误/入库）
// - 不做自动清理（人工按需），按天 + 200MB 滚动（简化为按天，201MB 阈值时加 .1 后缀轮转）
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const LOG_ROOT = path.join(config.root, 'data', 'logs');
const ROLL_SIZE = 200 * 1024 * 1024;

function logPath(kind: 'chat' | 'audit' | 'app'): string {
  const dir = path.join(LOG_ROOT, kind);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 按服务器本地日期分文件（2026-08-06：原 toISOString=UTC，凌晨时段日志会归到 UTC 前一天）
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let p = path.join(dir, `${day}.log`);
  if (fs.existsSync(p) && fs.statSync(p).size > ROLL_SIZE) {
    let i = 1;
    while (fs.existsSync(path.join(dir, `${day}.${i}.log`))) i++;
    p = path.join(dir, `${day}.${i}.log`);
  }
  return p;
}

function write(kind: 'chat' | 'audit' | 'app', record: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
    fs.appendFileSync(logPath(kind), line);
  } catch (e) {
    // 日志失败不应阻塞业务
    console.error('[log] write failed', e);
  }
}

export const logger = {
  chat: (rec: Record<string, unknown>) => write('chat', rec),
  audit: (rec: Record<string, unknown>) => write('audit', rec),
  app: (rec: Record<string, unknown>) => write('app', rec),
};