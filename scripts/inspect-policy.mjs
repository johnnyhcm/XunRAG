// 政策数据验证工具（2026-08-06）：一处查看三层数据
//   ①转换后的 Markdown 全文  ②切片含 metadata  ③向量库（Chroma）落库情况
// 用法：node scripts/inspect-policy.mjs [政策线ID | 政策名关键词]
import Database from 'better-sqlite3';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const db = new Database(path.join(root, 'data', 'policybot.db'), { readonly: true });
const arg = process.argv[2];

// 定位政策线
let line;
if (!arg) {
  const all = db.prepare('SELECT id, name FROM policy_lines ORDER BY created_at').all();
  console.log('可用政策线：');
  for (const l of all) console.log(`  ${l.id}  ${l.name}`);
  console.log('\n用法：node scripts/inspect-policy.mjs [线ID | 名称关键词]');
  process.exit(0);
}
line = db.prepare('SELECT id, name FROM policy_lines WHERE id=? OR name LIKE ?').get(arg, `%${arg}%`);
if (!line) { console.error('未找到政策线:', arg); process.exit(1); }
console.log(`\n========== 政策线：${line.name} (${line.id}) ==========`);

const versions = db.prepare(`SELECT id, version_no, status, effective_from, effective_to,
  convert_status, convert_quality, index_status, original_file_name, LENGTH(markdown_content) md_len, published_at
  FROM policy_versions WHERE line_id=? ORDER BY created_at`).all(line.id);

for (const v of versions) {
  console.log(`\n--- 版本 ${v.version_no ?? '?'} (${v.id.slice(0, 8)}) [${v.status}] ${v.effective_from ?? ''} ~ ${v.effective_to ?? '长期'} | 转换:${v.convert_status} 质量:${v.convert_quality} 入库:${v.index_status} | ${v.original_file_name}`);

  // ② 切片含 metadata
  const chunks = db.prepare(`SELECT chunk_index, retained, type, level, has_table, language,
    section_path, anchor, start_pos, end_pos, LENGTH(content) len
    FROM policy_chunks WHERE version_id=? ORDER BY chunk_index`).all(v.id);
  console.log(`  切片 ${chunks.length} 个（retained=${chunks.filter(c => c.retained).length}）:`);
  for (const c of chunks) {
    console.log(`    #${String(c.chunk_index).padStart(2)} ret=${c.retained ? 1 : 0} ${c.type.padEnd(12)} lvl=${(c.level || '-').padEnd(2)} 表=${c.has_table ? 1 : 0} len=${String(c.len).padStart(4)} | ${(c.section_path || '(无章节)').slice(0, 48)}${c.anchor ? ` [anchor:${c.anchor}]` : ''}`);
  }
  console.log('  ① Markdown 全文（前 600 字符）:');
  const md = db.prepare('SELECT markdown_content FROM policy_versions WHERE id=?').get(v.id).markdown_content ?? '';
  console.log('    ' + md.slice(0, 600).replace(/\n/g, '\n    ') + (md.length > 600 ? '\n    …(全文 ' + md.length + ' 字符)' : ''));
}

// ③ 向量库（Chroma）—— 通过 Python 查
console.log('\n--- ③ 向量库（Chroma）落库情况 ---');
const pyScript = `
import chromadb, json
client = chromadb.PersistentClient(path=${JSON.stringify(path.join(root, 'data', 'vector-db'))})
col = client.get_collection('policy_chunks')
data = col.get(include=['metadatas'])
vid = ${JSON.stringify(line.id)}
hits = [(m or {}).get('version_id') for m in data['metadatas'] if (m or {}).get('line_id') == vid]
from collections import Counter
print('该政策线在 Chroma 的 chunks:', len(hits))
for vid_, n in Counter(hits).items():
    print(f'  version {vid_[:8]}: {n} chunks')
`;
const r = spawnSync('python', ['-c', pyScript], { encoding: 'utf-8' });
console.log(r.stdout.split('\n').filter(Boolean).join('\n'));
if (r.status !== 0) console.log('（Python 查询失败: ' + (r.stderr || '').slice(0, 200) + '）');
db.close();
