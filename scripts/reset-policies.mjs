// 重置政策数据：清空 SQLite 政策表 + 上传文件 + 向量库（Chrom）
// 不动 conversations / messages / feedbacks / users（S3 对话数据保留）
// 用法：node scripts/reset-policies.mjs

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.join(root, 'data', 'policybot.db');
const uploadsDir = path.join(root, 'data', 'uploads');
const vectorDir = path.join(root, 'data', 'vector-db');

// 1) 清空 SQLite 政策表（FK 顺序：子表先）
console.log('[reset] 打开', dbPath);
const db = new Database(dbPath);
const tx = db.transaction(() => {
  db.exec(`DELETE FROM policy_references`);
  db.exec(`DELETE FROM policy_images`);
  db.exec(`DELETE FROM policy_chunks`);
  db.exec(`DELETE FROM policy_versions`);
  db.exec(`DELETE FROM policy_lines`);
  db.exec(`DELETE FROM policy_libraries`);
});
tx();
console.log('[reset] SQLite 政策表已清空');
db.close();

// 2) 删除上传文件
if (fs.existsSync(uploadsDir)) {
  fs.rmSync(uploadsDir, { recursive: true, force: true });
  console.log('[reset] 上传文件已删除');
}

// 3) 删除向量库（Chroma）
if (fs.existsSync(vectorDir)) {
  fs.rmSync(vectorDir, { recursive: true, force: true });
  console.log('[reset] 向量库已删除');
}

console.log('[reset] 完成 —— 政策数据已全部清除，对话/用户数据保留。');
