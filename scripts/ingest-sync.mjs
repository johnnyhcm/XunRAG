// 存量同步脚本（PRD §8.2 风险预案）
// 把所有已发布(status=published)、index_status≠indexed 的版本一次性向量化入库。
// 用法：node scripts/ingest-sync.mjs
// 适用：S3 起步时把 S2 已发布的政策补向量；或 Chroma 丢失后重建。
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
process.env.SQLITE_PATH ??= path.join(root, 'data', 'policybot.db');

// 动态加载 tsx 以运行 TS 后端模块
await import('tsx/esm');

const mod = await import(pathToFileURL(path.join(root, 'app', 'backend', 'src', 'db', 'index.js')).href.replace(/\.ts$|\.js$/, '.ts'));
const getDb = mod.getDb;

const ingest = await import(pathToFileURL(path.join(root, 'app', 'backend', 'src', 'services', 'ingest.ts')).href.replace(/\.js$/, '.ts'));
const ingestVersion = ingest.ingestVersion;

const db = getDb();
const versions = db.prepare(
  `SELECT v.id AS version_id, v.line_id, v.version_no, l.name AS line_name
   FROM policy_versions v
   JOIN policy_lines l ON v.line_id = l.id
   WHERE v.status = 'published' AND (v.index_status IS NULL OR v.index_status <> 'indexed')
   ORDER BY v.effective_from`,
).all() as { version_id: string; line_id: string; version_no: string | null; line_name: string }[];

console.log(`[sync] 待入库 ${versions.length} 个版本`);
let ok = 0, fail = 0;
for (let i = 0; i < versions.length; i++) {
  const v = versions[i];
  process.stdout.write(`[${i + 1}/${versions.length}] ${v.line_name} ${v.version_no ?? ''} ... `);
  try {
    const r = await ingestVersion(v.line_id, v.version_id);
    console.log(`OK indexed=${r.indexed}`);
    ok++;
  } catch (e: any) {
    console.log(`FAIL ${e?.message ?? e}`);
    fail++;
  }
}
console.log(`[sync] 完成：成功 ${ok} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);