// 入库管线（PRD §4.4.1）：发布后异步向量化
// Node 读该版本 retained=true 的 chunks → 拼 12 字段 metadata（含 version_id）→ POST /index 到 Python
// 2026-08-06 方案 B：同一政策线所有已发布版本全部入库（按版本区分，不覆盖）；
//   “当前生效”由检索时动态过滤（search.ts 每次算 getEffectiveVersionIds 传 /search），入库时机与生效判断解耦。
// 废止/删除版本时按 version 删向量（DELETE /index/version/{id}）；强制清理/删库按 line 整线删。
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { getNumber } from './config.js';

const PYTHON_BASE = config.pythonBaseUrl;

export interface IndexChunk {
  id: string;
  content: string;
  metadata: {
    file_id: string;       // = line_id（权限过滤键，S6 生效）
    version_id: string;    // 生效版本过滤键（方案 B：/search 按集合 $in 过滤）
    line_id: string;
    source: string;        // 政策名
    section_path: string;
    anchor: string;
    has_table: boolean;
    level: string;
    token_count?: number;  // 2026-08-13：切片 token 估算（技术详情展示）
    language?: string;     // 2026-08-13：切片语言（zh/en/mixed，多语言检索加权）
  };
}

/** 拉指定版本所有应入库 chunk（retained=true） */
function readIndexableChunks(versionId: string, lineId: string): { chunks: IndexChunk[]; lineName: string } | null {
  const db = getDb();
  const line: any = db.prepare('SELECT name FROM policy_lines WHERE id=?').get(lineId);
  if (!line) return null;
  const rows = db.prepare(
    `SELECT id, content, level, has_table, section_path, anchor, token_count, language FROM policy_chunks
     WHERE version_id=? AND retained=1 ORDER BY chunk_index`,
  ).all(versionId) as any[];
  const chunks: IndexChunk[] = rows.map((r, i) => ({
    id: r.id,
    content: r.content,
    metadata: {
      file_id: lineId,
      version_id: versionId,
      line_id: lineId,
      source: line.name || '政策',
      section_path: r.section_path ?? '',
      anchor: r.anchor || (r.section_path ? slugAnchor(r.section_path) : ''),
      has_table: !!r.has_table,
      level: r.level ?? '',
      token_count: Number(r.token_count) || undefined,
      language: r.language ?? 'zh', // 切片语言（多语言检索加权，2026-08-13）
    },
  }));
  return { chunks, lineName: line.name || '政策' };
}

function slugAnchor(sectionPath: string): string {
  // 章节锚点：取 path 最后一段做 slug
  const last = sectionPath.split(' > ').pop() ?? sectionPath;
  return last.replace(/[（(].*?[)）]/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'section';
}

/** 发布后将该版本 chunk 入 Chroma+BM25（方案 B：保留其他版本，先按 version_id 幂等删本版本旧数据再入库）
 *  失败时标记 index_status='failed' + index_error（错误原因），供管理页展示与重试 */
export async function ingestVersion(lineId: string, versionId: string): Promise<{ indexed: number }> {
  const data = readIndexableChunks(versionId, lineId);
  if (!data || data.chunks.length === 0) return { indexed: 0 };
  // 先删同 version_id 旧数据（幂等重入库）
  await fetch(`${PYTHON_BASE}/index/version/${versionId}`, { method: 'DELETE' }).catch(() => null);
  // 入库
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), getNumber('ingest.timeout_ms', 300_000));
  try {
    const res = await fetch(`${PYTHON_BASE}/index`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chunks: data.chunks }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Python /index ${res.status}: ${txt}`);
    }
    const r = (await res.json()) as { indexed: number };
    // 标记版本 indexed
    getDb().prepare(`UPDATE policy_versions SET index_status='indexed', index_error=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(versionId);
    return { indexed: r.indexed };
  } catch (e: any) {
    // 失败：记录原因（管理页展示 + 处理指引依据），不吞错
    const reason = String(e?.message ?? e);
    getDb().prepare(`UPDATE policy_versions SET index_status='failed', index_error=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(reason.slice(0, 500), versionId);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** 失效/删除：按 line_id 从 Chroma+BM25 删（强制清理/删库用） */
export async function removeFromIndex(lineId: string): Promise<void> {
  try {
    const res = await fetch(`${PYTHON_BASE}/index/${lineId}`, { method: 'DELETE' });
    if (!res.ok) console.error(`[ingest] removeFromIndex 失败 ${lineId}: HTTP ${res.status}`);
  } catch (e: any) {
    console.error(`[ingest] removeFromIndex 异常 ${lineId}:`, e?.message ?? e);
  }
}

/** 按版本从 Chroma+BM25 删（方案 B：废止/删除版本时用，多版本共存下删除粒度=版本） */
export async function removeVersionFromIndex(versionId: string): Promise<void> {
  try {
    const res = await fetch(`${PYTHON_BASE}/index/version/${versionId}`, { method: 'DELETE' });
    if (!res.ok) console.error(`[ingest] removeVersionFromIndex 失败 ${versionId}: HTTP ${res.status}`);
  } catch (e: any) {
    console.error(`[ingest] removeVersionFromIndex 异常 ${versionId}:`, e?.message ?? e);
  }
}

/** 手动/启动时索引一致性校验：清 Chroma 中 SQLite 不存在的孤儿（方案 B 版本级 + line 级双保险）
 *  不变量「向量库 = SQLite 已发布版本集合」——权限防泄露的关键兜底（ISSUE #33 根治：
 *  ①删除失败显性化（Python 侧已改 500 + 日志，见 retrieval.py）②此处补 line 级孤儿 ③失败计日志）
 *  @returns {cleaned: 清理数, failed: 失败数} */
export async function syncIndexFromDb(): Promise<{ cleaned: number; failed: number; skipped?: number }> {
  // 测试/运维开关：POLICYBOT_SKIP_SYNC=1 跳过（独立测试库启动时不得清理共享向量库）
  if (process.env.POLICYBOT_SKIP_SYNC === '1') return { cleaned: 0, failed: 0, skipped: 1 };
  // 2026-08-12 护栏 1（ISSUE #59 数据丢失根治）：显式指定 SQLITE_PATH（非默认库）而未设 SKIP_SYNC → 禁止清理共享索引。
  //   根因：隔离 SQLite 的测试后端启动时，本函数以临时库为孤儿判定基准，把共享正式 Chroma 全部判为孤儿删除（10 版本全丢事故）。
  //   保护责任在系统代码不在测试脚本——任何"隔离 SQLite"的启动必须显式声明知道自己在测试环境，否则默认不做破坏性清理。
  if (process.env.SQLITE_PATH && process.env.POLICYBOT_SKIP_SYNC !== '1') {
    console.error(`[ingest] ⛔ 索引同步已跳过：检测到 SQLITE_PATH=${process.env.SQLITE_PATH}（非默认正式库）且未设 POLICYBOT_SKIP_SYNC=1。`);
    console.error('[ingest] ⛔ 隔离 SQLite 的测试后端启动同步会把共享正式向量库（Chroma）全部判为孤儿删除（ISSUE #59 数据丢失事故）。请设 POLICYBOT_SKIP_SYNC=1 显式跳过；正式库启动请勿设置 SQLITE_PATH。');
    return { cleaned: 0, failed: 0, skipped: 1 };
  }
  try {
    const db = getDb();
    let cleaned = 0, failed = 0;
    const del = async (url: string, label: string): Promise<boolean> => {
      try {
        const dr = await fetch(`${PYTHON_BASE}${url}`, { method: 'DELETE', signal: AbortSignal.timeout(15_000) });
        if (!dr.ok) { failed++; console.error(`[ingest] 同步清理孤儿失败 ${label}: HTTP ${dr.status} ${(await dr.text().catch(() => '')).slice(0, 200)}`); return false; }
        cleaned++; return true;
      } catch (e: any) { failed++; console.error(`[ingest] 同步清理孤儿异常 ${label}:`, e?.message ?? e); return false; }
    };
    // ① 版本级：Chroma version_id ∉ SQLite 已发布集合 → 删（按版本）
    const sqlVersions = db.prepare(`SELECT id FROM policy_versions WHERE status='published'`).all() as { id: string }[];
    const sqlSet = new Set(sqlVersions.map((r) => r.id));
    const res = await fetch(`${PYTHON_BASE}/index/version-ids`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) { console.error(`[ingest] 索引同步失败：version-ids HTTP ${res.status}`); return { cleaned: 0, failed: 1 }; }
    const { version_ids } = await res.json() as { version_ids: string[] };
    // 2026-08-12 护栏 2（ISSUE #59 双保险）：Chroma 有数据但当前 SQLite 已发布版本与其零交集 → 孤儿判定基准可疑
    //   （典型场景：临时 SQLite 只有测试版本，连的是共享正式 Chroma）→ 拒绝清理，宁可漏清不可误删。
    //   生产不误伤：正常入库链路保证 Chroma 必含当前 SQLite 已发布版本的向量，交集必然非空。
    if (version_ids.length > 0) {
      const matched = version_ids.filter((v) => sqlSet.has(v)).length;
      if (matched === 0) {
        console.error(`[ingest] ⛔ 索引同步中止：Chroma 含 ${version_ids.length} 个版本，但当前 SQLite 已发布版本（${sqlSet.size} 个）与 Chroma 零交集——孤儿判定基准可疑（疑似测试库误连共享索引，ISSUE #59），已拒绝清理。`);
        console.error('[ingest] ⛔ 如确需强制清理（历史孤儿），请确认数据源无误后运行 scripts/sync-index.mjs 手动执行。');
        return { cleaned: 0, failed: 0, skipped: 1 };
      }
    }
    for (const vid of version_ids) {
      if (!sqlSet.has(vid)) await del(`/index/version/${encodeURIComponent(vid)}`, `version ${vid.slice(0, 8)}`);
    }
    // ② line 级（双保险，ISSUE #33）：Chroma line_id ∉ SQLite policy_lines → 删（按 line）
    const sqlLines = new Set((db.prepare('SELECT id FROM policy_lines').all() as { id: string }[]).map((r) => r.id));
    const lres = await fetch(`${PYTHON_BASE}/index/line-ids`, { signal: AbortSignal.timeout(10_000) });
    if (lres.ok) {
      const { line_ids } = await lres.json() as { line_ids: string[] };
      // 2026-08-12 护栏 2（line 级同版本级）：Chroma line 与当前 SQLite policy_lines 零交集 → 拒绝清理（ISSUE #59）
      if (line_ids.length > 0) {
        const matched = line_ids.filter((lid) => sqlLines.has(lid)).length;
        if (matched === 0) {
          console.error(`[ingest] ⛔ 索引同步中止（line 级）：Chroma 含 ${line_ids.length} 个 line，当前 SQLite policy_lines（${sqlLines.size} 个）零交集——基准可疑，拒绝清理（ISSUE #59）。`);
          return { cleaned: 0, failed: 0, skipped: 1 };
        }
      }
      for (const lid of line_ids) {
        if (!sqlLines.has(lid)) await del(`/index/${encodeURIComponent(lid)}`, `line ${lid.slice(0, 8)}`);
      }
    }
    console.log(`[ingest] 索引同步：清理 ${cleaned} 条孤儿（版本+line）${failed ? `，失败 ${failed} 条（见上日志，可运行 scripts/sync-index.mjs 重试）` : ''}`);
    return { cleaned, failed };
  } catch (e: any) { console.error('[ingest] 索引同步异常:', e?.message ?? e); return { cleaned: 0, failed: 1 }; }
}