#!/usr/bin/env node
// 一键恢复脚本（S8 稳定性③，2026-08-13）—— 灾难恢复核心，fail-safe 设计
//   顺序：校验备份 → 探测服务 → 停服务 → 备份当前数据(安全网) → 还原 → 校验 → 提示起服务
//   安全网：还原前把"当前(可能更新的)数据"先备份到 data/backup/_pre-restore-<ts>/，还原错了可反悔。
//   校验：还原后打开 SQLite 读表行数；双存储一致性靠后端启动 syncIndexFromDb / 手动 scripts/sync-index.mjs。
// 用法：
//   node scripts/restore.mjs data/backup/2026-08-13_21-48-29            # 预览+确认（服务运行中会拒绝）
//   node scripts/restore.mjs data/backup/2026-08-13_21-48-29 --yes      # 跳过确认
//   node scripts/restore.mjs data/backup/2026-08-13_21-48-29 --stop     # 自动停服务(taskkill)后还原
//   SQLITE_PATH=xxx node scripts/restore.mjs <backup-dir>               # 还原到指定库
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(root, 'data', 'policybot.db');
const DATA_DIR = path.dirname(SQLITE_PATH);
const backupDir = process.argv[2];
const YES = process.argv.includes('--yes');
const STOP = process.argv.includes('--stop');

const pad = (n) => String(n).padStart(2, '0');
const ts = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`; };

function log(...a) { console.log(...a); }

function portPid(port) {
  try {
    const out = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, { encoding: 'utf8' });
    const m = out.split('\n').find((l) => l.includes(`:${port}`));
    if (!m) return null;
    const pid = m.trim().split(/\s+/).pop();
    return pid && /^\d+$/.test(pid) ? Number(pid) : null;
  } catch { return null; }
}

function killByPort(port, label) {
  const pid = portPid(port);
  if (!pid) { log(`[restore] ${label} 未运行`); return; }
  log(`[restore] 停止 ${label}（PID ${pid}）…`);
  try { execSync(`taskkill /PID ${pid} /T /F`, { encoding: 'utf8' }); } catch { /* 已退出 */ }
  log(`[restore] ✅ ${label} 已停止`);
}

function dirSize(dir) { let t = 0; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); t += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } return t; }

function main() {
  if (!backupDir) { console.error('用法：node scripts/restore.mjs <backup-dir> [--yes] [--stop]'); process.exit(1); }
  const src = path.resolve(backupDir);
  const dbFile = path.basename(SQLITE_PATH);
  const manifestPath = path.join(src, 'manifest.json');
  if (!fs.existsSync(path.join(src, dbFile))) { console.error(`[restore] ❌ 备份目录无 ${dbFile}：${src}`); process.exit(1); }
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  log(`[restore] 待还原备份：${src}`);
  log(`[restore] manifest：${manifest ? `创建于 ${manifest.created_at}，SQLite 行数 ${JSON.stringify(manifest.items?.[dbFile]?.counts ?? {})}` : '(无 manifest，旧格式)'}`);

  // 探测服务（还原前必须停，否则覆盖正在持有的文件会损坏/崩溃）
  const bePid = portPid(3000), pyPid = portPid(8001);
  if (bePid || pyPid) {
    if (!STOP) {
      console.error(`[restore] ❌ 服务运行中（backend PID=${bePid ?? '-'} / python PID=${pyPid ?? '-'}），还原会损坏数据。请先停止服务，或用 --stop 自动停止。`);
      process.exit(1);
    }
    killByPort(3000, 'backend');
    killByPort(8001, 'python');
  } else {
    log('[restore] 服务未运行，直接还原');
  }

  if (!YES) {
    process.stdout.write('[restore] 确认还原？（将覆盖当前数据，输入 yes 继续）：');
    const buf = fs.readFileSync(0, 'utf8');
    if (buf.trim().toLowerCase() !== 'yes') { log('[restore] 已取消'); process.exit(0); }
  }

  // 安全网：还原前先备份当前数据（此时服务已停，copy 一致）
  const preRestore = path.join(DATA_DIR, 'backup', `_pre-restore-${ts()}`);
  fs.mkdirSync(preRestore, { recursive: true });
  log(`[restore] 安全网：当前数据备份到 ${preRestore}`);
  for (const f of [dbFile]) if (fs.existsSync(path.join(DATA_DIR, f))) fs.copyFileSync(path.join(DATA_DIR, f), path.join(preRestore, f));
  for (const d of ['vector-db', 'uploads', 'pi-sessions']) if (fs.existsSync(path.join(DATA_DIR, d))) fs.cpSync(path.join(DATA_DIR, d), path.join(preRestore, d), { recursive: true });

  // 还原
  log('[restore] 还原中…');
  for (const f of [dbFile]) { fs.copyFileSync(path.join(src, f), path.join(DATA_DIR, f)); log(`  ✅ ${f}`); }
  for (const d of ['vector-db', 'uploads', 'pi-sessions']) {
    const s = path.join(src, d), dst = path.join(DATA_DIR, d);
    if (fs.existsSync(s)) { fs.rmSync(dst, { recursive: true, force: true }); fs.cpSync(s, dst, { recursive: true }); log(`  ✅ ${d}（${(dirSize(dst) / 1024 / 1024).toFixed(1)}MB）`); }
    else log(`  -  ${d}（备份无此项，跳过）`);
  }
  // 清掉还原库的 WAL 残留（避免旧 wal 与新 db 不匹配）
  for (const suffix of ['-shm', '-wal']) { const f = path.join(DATA_DIR, dbFile + suffix); if (fs.existsSync(f)) fs.rmSync(f, { force: true }); }

  // 校验：还原的 SQLite 可读
  const chk = new Database(path.join(DATA_DIR, dbFile), { readonly: true });
  const counts = {};
  for (const t of ['users', 'policy_lines', 'policy_versions', 'policy_chunks', 'messages']) { try { counts[t] = chk.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch {} }
  chk.close();
  log(`[restore] ✅ 还原完成，SQLite 校验可读：${JSON.stringify(counts)}`);
  log('[restore] 下一步：');
  log('  1) 启动服务（backend + python）');
  log('  2) 校验双存储一致性：node scripts/sync-index.mjs --dry-run（或后端启动自动 syncIndexFromDb）');
  log(`  3) 若检索异常：node scripts/reindex-all.mjs（从 SQLite markdown 重建向量库）`);
  log(`  ⚠️ 还原错了可反悔：安全网在 ${preRestore}`);
}

main();
