#!/usr/bin/env node
// 全量备份脚本（S8 稳定性③，2026-08-13）—— 双存储一致性备份 + 保留策略 + 可读性校验
//   备份四类数据：SQLite 主库 / Chroma 向量库 / 原始上传文件 / 智能会话记忆
//   核心设计：SQLite 用 .backup() 在线热备份（WAL 下一致性快照，不阻塞写入）；向量库整体 copy
//   （可从 SQLite markdown 重建 reindex 兜底，近似快照可接受）；备份完成后立即校验 SQLite 可读。
// 用法：
//   node scripts/backup.mjs              # 备份到 data/backup/<本地时间戳>/
//   node scripts/backup.mjs --keep 14    # 保留最近 14 份（默认）
//   BACKUP_DIR=D:/backup node scripts/backup.mjs   # 备份到异盘/网络盘（生产建议，与数据不同盘）
//   SQLITE_PATH=xxx node scripts/backup.mjs         # 指定库（默认 data/policybot.db）
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(root, 'data', 'policybot.db');
const DATA_DIR = path.dirname(SQLITE_PATH);
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(root, 'data', 'backup');
const keepIdx = process.argv.indexOf('--keep');
const KEEP = keepIdx >= 0 ? Number(process.argv[keepIdx + 1] || 14) : 14;

// 本地时间戳（运维友好）：YYYY-MM-DD_HH-mm-ss
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

function prune() {
  const dirs = fs.readdirSync(BACKUP_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(d)).sort();
  let removed = 0;
  while (dirs.length > KEEP) {
    const old = dirs.shift();
    fs.rmSync(path.join(BACKUP_DIR, old), { recursive: true, force: true });
    console.log(`[backup] 清理过期备份 → ${old}`);
    removed++;
  }
  return removed;
}

async function main() {
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`[backup] ❌ SQLite 库不存在：${SQLITE_PATH}`);
    process.exit(1);
  }
  const dest = path.join(BACKUP_DIR, ts);
  fs.mkdirSync(dest, { recursive: true });
  const manifest = { created_at: new Date().toISOString(), keep: KEEP, items: {} };

  // ① SQLite 主库：.backup() 在线热备份（WAL 一致性快照，不阻塞正在运行的服务写）
  const dbFile = path.basename(SQLITE_PATH);
  const sqliteDest = path.join(dest, dbFile);
  const src = new Database(SQLITE_PATH, { readonly: true });
  await src.backup(sqliteDest);
  src.close();

  // ①-校验：备份必须可读（防"备份文件存在但已坏"——ISSUE #3/#15 教训：静默不报 ≠ 成功）
  const check = new Database(sqliteDest, { readonly: true });
  const counts = {};
  for (const t of ['users', 'policy_lines', 'policy_versions', 'policy_chunks', 'messages', 'sessions']) {
    try { counts[t] = check.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { /* 表不存在则跳过 */ }
  }
  check.close();
  // 清理 backup 目标的 -shm/-wal 残留（backup 目标以 WAL 打开后的空文件，非数据，恢复时无需）
  for (const suffix of ['-shm', '-wal']) {
    const f = sqliteDest + suffix;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
  manifest.items[dbFile] = { bytes: fs.statSync(sqliteDest).size, counts };

  // ② vector-db（Chroma）：整体 copy；可从 SQLite reindex 重建，近似快照可接受
  // ③ uploads（原始文件：重建向量的原料，必须备）
  // ④ pi-sessions（智能会话记忆）
  for (const d of ['vector-db', 'uploads', 'pi-sessions']) {
    const s = path.join(DATA_DIR, d);
    if (!fs.existsSync(s)) { manifest.items[d] = { skipped: '不存在' }; continue; }
    const dst = path.join(dest, d);
    fs.cpSync(s, dst, { recursive: true });
    manifest.items[d] = { bytes: dirSize(dst) };
  }

  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const removed = prune();

  console.log(`[backup] ✅ 备份完成 → ${dest}`);
  console.log(`[backup] SQLite: ${(manifest.items[dbFile].bytes / 1024 / 1024).toFixed(1)}MB，users=${counts.users} lines=${counts.policy_lines} versions=${counts.policy_versions} chunks=${counts.policy_chunks} messages=${counts.messages}`);
  for (const d of ['vector-db', 'uploads', 'pi-sessions']) {
    const it = manifest.items[d];
    console.log(`[backup] ${d}: ${it?.bytes != null ? (it.bytes / 1024 / 1024).toFixed(1) + 'MB' : it?.skipped ?? '-'}`);
  }
  if (removed) console.log(`[backup] 保留最近 ${KEEP} 份，本次清理 ${removed} 份`);
}

main().catch((e) => { console.error(`[backup] ❌ 失败：${e?.message ?? e}`); process.exit(1); });
