// 全量重索引工具（2026-08-06 方案 B 迁移用）：
// 遍历所有已发布版本重入库 —— 为存量 Chroma 数据补齐 version_id 元数据
// （旧代码覆盖式入库的数据无 version_id，方案 B 检索过滤会全部滤掉；重索引后恢复正常）
// 用法：node scripts/reindex-all.mjs
// 说明：2026-08-06 修复 Windows 下 spawnSync(npx) 无输出问题，改为纯 node 实现（直接读 SQLite + 调 Python /index）
import Database from 'better-sqlite3';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const PY = process.env.PYTHON_BASE_URL || 'http://127.0.0.1:8001';
const db = new Database(path.join(root, 'data', 'policybot.db'));

const slug = (p) => {
  const last = (p.split(' > ').pop() || p);
  return last.replace(/[（(].*?[)）]/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'section';
};

async function main() {
  // Python 可达性
  try {
    const h = await fetch(`${PY}/health`).then((r) => r.json());
    if (h.status !== 'ok') throw new Error('python not ok');
  } catch (e) {
    console.error('[reindex-all] Python 检索引擎不可达（' + String(e) + '），请先启动 python server.py');
    process.exit(1);
  }
  const versions = db.prepare(`SELECT id, line_id, version_no FROM policy_versions WHERE status='published'`).all();
  if (!versions.length) { console.log('[reindex-all] 无已发布版本，无需重索引'); return; }
  console.log(`[reindex-all] 待重索引版本：${versions.length}`);
  let ok = 0, fail = 0;
  for (const v of versions) {
    try {
      const line = db.prepare('SELECT name FROM policy_lines WHERE id=?').get(v.line_id);
      const chunks = db.prepare('SELECT id, content, level, has_table, section_path, language FROM policy_chunks WHERE version_id=? AND retained=1 ORDER BY chunk_index').all(v.id);
      if (!chunks.length) { console.log(`  - ${v.version_no}（${v.id.slice(0, 8)}）无 retained 切片，跳过`); ok++; continue; }
      const payload = chunks.map((c) => ({
        id: c.id,
        content: c.content,
        metadata: {
          file_id: v.line_id, version_id: v.id, line_id: v.line_id,
          source: line?.name || '政策',
          section_path: c.section_path ?? '',
          anchor: c.section_path ? slug(c.section_path) : '',
          has_table: !!c.has_table, section: c.section_path ?? '', level: c.level ?? '',
          language: c.language ?? 'zh',
        },
      }));
      await fetch(`${PY}/index/version/${v.id}`, { method: 'DELETE' }).catch(() => null);
      const res = await fetch(`${PY}/index`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chunks: payload }),
      });
      if (!res.ok) throw new Error(`/index ${res.status}`);
      const r = await res.json();
      console.log(`  ✓ ${v.version_no}（${v.id.slice(0, 8)}）${r.indexed} chunks`);
      ok++;
    } catch (e) {
      fail++;
      console.error(`  ✗ ${v.version_no}（${v.id.slice(0, 8)}）${String(e.message ?? e).slice(0, 120)}`);
    }
  }
  console.log(`[reindex-all] ${ok} 成功 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('[reindex-all] 异常:', e); process.exit(1); });
