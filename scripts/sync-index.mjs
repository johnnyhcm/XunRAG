#!/usr/bin/env node
// 索引一致性手动清理（ISSUE #33 根治，2026-08-07）
// 比对 SQLite 与 Chroma：清掉 Chroma 中 SQLite 不存在的孤儿向量（版本级 + line 级双保险）
//   不变量「向量库 = SQLite 已发布版本集合」——权限防泄露兜底（孤儿向量可能被检索命中已删除内容）
// 用法：
//   node scripts/sync-index.mjs            # 正常清理（幂等，可重复跑）
//   node scripts/sync-index.mjs --dry-run  # 只报告不删除（预览将清理哪些孤儿）
//   SQLITE_PATH=xxx node scripts/sync-index.mjs   # 指定库（默认 data/policybot.db）
//   PYTHON_BASE_URL=xxx node scripts/sync-index.mjs  # 指定 Python（默认 http://localhost:8001）
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(root, 'data', 'policybot.db');
const PY = process.env.PYTHON_BASE_URL || 'http://localhost:8001';
const DRY = process.argv.includes('--dry-run');

const db = new Database(SQLITE_PATH, { readonly: true });
const sqlVersions = new Set(db.prepare(`SELECT id FROM policy_versions WHERE status='published'`).all().map((r) => r.id));
const sqlLines = new Set(db.prepare('SELECT id FROM policy_lines').all().map((r) => r.id));
db.close();

const del = async (url, label) => {
  const r = await fetch(`${PY}${url}`, { method: 'DELETE', signal: AbortSignal.timeout(15000) });
  if (!r.ok) { console.error(`  ❌ 删除失败 ${label}: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 150)}`); return false; }
  return true;
};

async function main() {
  console.log(`[sync-index] ${DRY ? 'DRY-RUN（只报告不删除）' : '清理孤儿向量'} ｜ db=${SQLITE_PATH} ｜ python=${PY}`);
  let cleaned = 0, failed = 0;
  const orphanVersions = [], orphanLines = [];

  // ① 版本级孤儿
  const vr = await fetch(`${PY}/index/version-ids`, { signal: AbortSignal.timeout(10000) });
  if (!vr.ok) { console.error(`[sync-index] 获取 version-ids 失败: HTTP ${vr.status}（Python 未启动？）`); process.exit(2); }
  const { version_ids = [] } = await vr.json();
  for (const vid of version_ids) if (!sqlVersions.has(vid)) orphanVersions.push(vid);

  // ② line 级孤儿
  const lr = await fetch(`${PY}/index/line-ids`, { signal: AbortSignal.timeout(10000) });
  if (lr.ok) {
    const { line_ids = [] } = await lr.json();
    for (const lid of line_ids) if (!sqlLines.has(lid)) orphanLines.push(lid);
  }

  console.log(`  版本级孤儿 ${orphanVersions.length} 条: ${orphanVersions.map((v) => v.slice(0, 8)).join(', ') || '无'}`);
  console.log(`  line 级孤儿 ${orphanLines.length} 条: ${orphanLines.map((l) => l.slice(0, 8)).join(', ') || '无'}`);

  if (DRY) { console.log('[sync-index] DRY-RUN 结束（未删除任何数据）'); process.exit(0); }

  for (const vid of orphanVersions) { if (await del(`/index/version/${encodeURIComponent(vid)}`, `version ${vid.slice(0, 8)}`)) cleaned++; else failed++; }
  for (const lid of orphanLines) { if (await del(`/index/${encodeURIComponent(lid)}`, `line ${lid.slice(0, 8)}`)) cleaned++; else failed++; }

  console.log(`[sync-index] 完成：清理 ${cleaned} 条孤儿${failed ? `，失败 ${failed} 条（见上，检查 Python 后重跑）` : ''}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[sync-index] 异常:', e); process.exit(2); });
