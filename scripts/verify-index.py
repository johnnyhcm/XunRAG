# -*- coding: utf-8 -*-
"""切片与向量库一致性校验（2026-08-06）：
对比 SQLite(policy_chunks, published 版本 retained=1) 与 Chroma 逐条 (id, content, version_id)。
用法：python scripts/verify-index.py"""
import sqlite3
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'app', 'python'))
import chromadb

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DB_PATH = os.path.join(ROOT, 'data', 'policybot.db')
CHROMA_PATH = os.path.join(ROOT, 'data', 'vector-db')

# ---- SQLite 侧 ----
db = sqlite3.connect(DB_PATH)
sql_chunks = {}
for (vid,) in db.execute("SELECT id FROM policy_versions WHERE status='published'").fetchall():
    for cid, content in db.execute(
        "SELECT id, content FROM policy_chunks WHERE version_id=? AND retained=1", (vid,)):
        sql_chunks[cid] = {'content': content or '', 'version_id': vid}
print('SQLite 侧 chunks:', len(sql_chunks))

# ---- Chroma 侧 ----
client = chromadb.PersistentClient(path=CHROMA_PATH)
col = client.get_collection('policy_chunks')
data = col.get(include=['documents', 'metadatas'])
chroma = {}
for i, cid in enumerate(data['ids']):
    m = data['metadatas'][i] or {}
    chroma[cid] = {
        'content': data['documents'][i] if i < len(data['documents']) else '',
        'version_id': m.get('version_id'),
    }
print('Chroma 侧 chunks:', len(chroma))

missing = [i for i in sql_chunks if i not in chroma]
ghost = [i for i in chroma if i not in sql_chunks]
drift = [i for i in sql_chunks if i in chroma and chroma[i]['content'] != sql_chunks[i]['content']]
vid_mismatch = [i for i in sql_chunks if i in chroma and chroma[i]['version_id'] != sql_chunks[i]['version_id']]

print('缺失（SQLite 有 Chroma 无）:', len(missing))
print('幽灵（Chroma 有 SQLite 无）:', len(ghost))
print('内容漂移（id 同 content 异）:', len(drift))
print('version 归属不一致:', len(vid_mismatch))
for label, arr in [('缺失', missing), ('幽灵', ghost), ('漂移', drift), ('归属', vid_mismatch)]:
    for cid in arr[:3]:
        print(f'  {label}: {cid}')

if not (missing or ghost or drift or vid_mismatch):
    print('>>> 结论：切片与向量库完全匹配（逐条 id/content/version_id 一致）')
else:
    print('>>> 结论：存在不一致，见上')
