#!/usr/bin/env python
"""存量 HTML 表格修复（2026-08-06，PRD §4.2.2 / TECH §3.0）

背景：pandoc 对复杂 Word 表格输出 <table> HTML，历史版本（编号如 POL-005/006）以
HTML 原样入库，检索时中文词被标签/英文稀释（精确词召回趋 0，数字答案退化为猜测）。

本脚本：
1. 更新 policy_versions.markdown_content（智能模式 policy_grep 全文检索的数据源）
2. 更新 policy_chunks.content（高效模式向量/BM25 的数据源，保留 retained/切片结构）
3. 对受影响的已发布版本调用 Node reindex API 重新入库（覆盖语义，幂等）

用法：python scripts/fix-html-tables.py [--api http://localhost:3000]
说明：不动 slice_plan 与 metadata（保留人工切片边界）；幂等（重复跑无副作用）
"""
import json
import os
import sqlite3
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, "data", "policybot.db")
sys.path.insert(0, os.path.join(ROOT, "app", "python"))
from utils.mdpost import html_table_to_markdown  # noqa: E402

API = sys.argv[sys.argv.index("--api") + 1] if "--api" in sys.argv else "http://localhost:3000/api"


def main() -> int:
    db = sqlite3.connect(DB)
    db.execute("PRAGMA journal_mode=WAL")

    # 1) 受影响版本（markdown_content 含 <table>）
    versions = db.execute(
        "SELECT id, line_id, version_no, status FROM policy_versions WHERE markdown_content LIKE '%<table>%'"
    ).fetchall()
    if not versions:
        print("无含 HTML 表格的版本，无需修复（幂等）")
        return 0

    print(f"发现 {len(versions)} 个含 HTML 表格的版本：")
    fixed_versions = []
    for vid, line_id, vno, status in versions:
        row = db.execute("SELECT markdown_content FROM policy_versions WHERE id=?", (vid,)).fetchone()
        new_md = html_table_to_markdown(row[0])
        db.execute("UPDATE policy_versions SET markdown_content=? WHERE id=?", (new_md, vid))
        # chunk 内容同步
        chunks = db.execute(
            "SELECT id, content FROM policy_chunks WHERE version_id=? AND content LIKE '%<table>%'", (vid,)
        ).fetchall()
        for cid, content in chunks:
            db.execute("UPDATE policy_chunks SET content=? WHERE id=?", (html_table_to_markdown(content), cid))
        fixed_versions.append((vid, line_id, vno, status, len(chunks)))
        print(f"  {vno} (line={line_id}, status={status}): 更新 markdown + {len(chunks)} 个 chunk")

    db.commit()
    db.close()

    # 2) 对已发布版本重新入库（Chroma + BM25；覆盖语义）
    for vid, line_id, vno, status, n in fixed_versions:
        if status != "published":
            print(f"  跳过重新入库（非已发布）：{vno}")
            continue
        req = urllib.request.Request(
            f"{API}/policies/{line_id}/versions/{vid}/reindex",
            data=b"",
            headers={"content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                r = json.loads(resp.read())
            print(f"  重新入库 {vno}: ok, indexed={r.get('indexed')}")
        except Exception as e:
            print(f"  ❌ 重新入库 {vno} 失败: {e}")

    print("\n完成。建议验证：搜'仅长期''住房补贴'应能召回到 005 表格 chunk。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
