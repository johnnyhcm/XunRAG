#!/usr/bin/env node
// 登录/密码迁移（S6 完整用户系统，2026-08-07）——幂等，重复跑无副作用
// 1) users 加 password_hash 列
// 2) 建 sessions 表
// 3) 存量用户初始密码统一 Pass1234（仅 password_hash IS NULL 的用户——不覆盖已改密/已设密码）
import Database from 'better-sqlite3';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(path.join(root, 'data', 'policybot.db'));

const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
const hasTable = (t) => !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);

// 1) users.password_hash
if (!hasCol('users', 'password_hash')) {
  db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
  console.log('users.password_hash 已加');
}

// 1.5) users.must_change_password（首次登录强制改密标志，2026-08-09）
if (!hasCol('users', 'must_change_password')) {
  db.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0`);
  console.log('users.must_change_password 已加');
}
// 存量用户置 1（2026-08-09）：存量密码均为统一 Pass1234 弱口令——配置 force_change_on_first_login 开启即强制改密（幂等：仅置未标记的）
db.prepare(`UPDATE users SET must_change_password=1 WHERE password_hash IS NOT NULL AND must_change_password=0`).run();
console.log('存量用户 must_change_password 已置 1（弱口令强制改密，配置开启后生效）');

// 2) sessions 表
if (!hasTable('sessions')) {
  db.exec(`CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at)');
  console.log('sessions 表已建');
}

// 3) 存量用户初始密码（统一 Pass1234，仅未设置的）
const hash = (() => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync('Pass1234', salt, 64).toString('hex')}`;
})();
const r = db.prepare(`UPDATE users SET password_hash=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE password_hash IS NULL`).run(hash);
console.log(`存量用户初始密码已设置：${r.changes} 个（统一 Pass1234）`);

db.close();
console.log('登录/密码迁移完成（幂等）');
