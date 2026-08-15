// SQLite 初始化（better-sqlite3，单文件零部署 —— TECH.md §2）
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath = config.sqlitePath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // 首次启动：建用户表（schema.sql 是源码资源，基于 config.root 固定路径读——tsc 不复制非 ts 文件到 dist，
  // 用 import.meta.dirname 在 dist 下会找不到，2026-08-13 部署隐患修复）
  const schemaSql = fs.readFileSync(
    path.join(config.root, 'app', 'backend', 'src', 'db', 'schema.sql'),
    'utf8',
  );
  db.exec(schemaSql);
  // 幂等迁移：索引失败原因字段（A 项，2026-08-06）——已存在则忽略
  try {
    db.exec(`ALTER TABLE policy_versions ADD COLUMN index_error TEXT`);
  } catch { /* 已存在 */ }
  // S2 起还需 images 目录，放在 data/uploads 下
  const uploadsDir = path.join(path.dirname(dbPath), 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  return db;
}

/** 关闭连接（测试用） */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}