"""存量数据修复：为 html_content 为空的 MD 版本回填 HTML（幂等，可重复跑）

背景：convert.py 的 MD 分支曾不生成 html_content（空串），导致员工阅读页空白。
该缺陷已在代码层修复（新上传的 MD 会生成 HTML 片段），但**存量版本**不会自动补。
本脚本用库内已存的 markdown_content 直接生成 HTML 回填，无需重新上传原文件。

用法：python scripts/backfill-md-html.py [db_path]
默认 db 为 data/policybot.db（与后端一致）。
安全：仅更新 html_content 为空/NULL 且 markdown_content 非空的版本；跳过其它行。
"""
import os
import sqlite3
import sys

import pypandoc

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DB_PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "data", "policybot.db")


def md_to_html(md: str) -> str:
    """与 convert.py MD 分支一致：gfm → html5 片段（不含 <html>/<head> 嵌套文档）"""
    return pypandoc.convert_text(md, "html5", format="gfm", extra_args=["--wrap=none"])


def main() -> int:
    if not os.path.exists(DB_PATH):
        print(f"[backfill] db 不存在: {DB_PATH}")
        return 1
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT id, line_id, version_no, status, original_file_name, markdown_content
        FROM policy_versions
        WHERE markdown_content IS NOT NULL
          AND (html_content IS NULL OR html_content = '')
        """
    ).fetchall()
    if not rows:
        print("[backfill] 没有需要回填的版本")
        conn.close()
        return 0

    print(f"[backfill] 发现 {len(rows)} 个待回填版本")
    ok = fail = 0
    for r in rows:
        try:
            html = md_to_html(r["markdown_content"])
            conn.execute(
                "UPDATE policy_versions SET html_content=?, updated_at=datetime('now') WHERE id=?",
                (html, r["id"]),
            )
            conn.commit()
            ok += 1
            print(
                f"  [OK] {r['status']} {r['version_no'] or '-'} "
                f"{r['original_file_name'] or r['id']} -> html {len(html)} chars"
            )
        except Exception as e:
            fail += 1
            print(f"  [FAIL] {r['id']} backfill error: {e}")
    conn.close()
    print(f"[backfill] 完成：{ok} 成功 / {fail} 失败")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
