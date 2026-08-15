#!/usr/bin/env node
// 索引一致性同步（2026-08-07，权限防泄露兜底）：清 Chroma/BM25 中 SQLite 不存在的已发布版本
// 不变量「向量库 = SQLite 已发布版本集合」——孤儿向量（已删/废止版本的残留）是检索权限泄露的潜在源
// 用法：cd app/backend && npx tsx ../../scripts/index-sync.mjs
import { syncIndexFromDb } from '../app/backend/src/services/ingest.js';

const cleaned = await syncIndexFromDb();
console.log(`索引同步完成：清理孤儿向量 ${cleaned} 条（Chroma/BM25 已与 SQLite 已发布版本集合对齐）`);
process.exit(0);
