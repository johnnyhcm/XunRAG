"""Word→Markdown 转换路由（S2）

流程（对齐 PRD §4.2.2 / D2 决策）：
  1. pypandoc docx→gfm，--extract-media 提取图片到本地
  2. 后处理 markdown：规范化转义、grid table→pipe table
  3. 按段落切分 segment，标记类型：
     - cover：标题/制度编号/部门/日期密集区域（首部）
     - toc：含"目录""目 录"或大量连续短行带页码
     - header_footer：页眉页脚（pandoc 通常已丢弃，兜底检测）
     - body：正文
  4. 每段语言检测（字符集比例，P7 方案）
  5. 返回 markdown + segments + images
"""
import os
import re
import base64
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import pypandoc
import tempfile

from utils.language import detect_lang
from utils.mdpost import (
    normalize_markdown,
    split_segments,
    infer_headings,
    has_any_heading,
    html_table_to_markdown,
)

router = APIRouter()


class ConvertRequest(BaseModel):
    file_path: str
    media_dir: Optional[str] = None  # 图片输出目录；不传则与 md 同目录 images


class Segment(BaseModel):
    index: int
    text: str
    lang: str
    type: str  # body / cover / toc / header_footer


class ImageInfo(BaseModel):
    original_name: str
    stored_path: str
    position: int  # 段落序号


class ConvertResponse(BaseModel):
    markdown: str
    html: str  # Word→HTML 用于员工阅读页（内嵌图片 base64，无下载入口）
    segments: list[Segment]
    images: list[ImageInfo]
    quality: str  # ok / need_review


@router.post("/convert")
def convert(req: ConvertRequest):
    path = req.file_path
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"file not found: {path}")

    out_dir = os.path.dirname(path) or "."
    media_base = req.media_dir or os.path.join(out_dir, "images")
    os.makedirs(media_base, exist_ok=True)
    html_content = ""

    # pandoc：docx → gfm，提取媒体到 media_base
    # 使用 tmp md 输出再读回，便于处理
    ext = os.path.splitext(path)[1].lower()
    if ext in (".md", ".markdown"):
        with open(path, "r", encoding="utf-8") as f:
            raw_md = f.read()
        images: list[ImageInfo] = []
        # MD → HTML 片段（与 Word 分支同一 html_content 语义，供员工阅读页渲染；
        # 不加 --standalone，避免产出 <html><head> 嵌套文档）
        try:
            html_content = pypandoc.convert_text(
                raw_md, "html5", format="gfm", extra_args=["--wrap=none"]
            )
        except Exception:
            html_content = ""
    else:
        tmp_md = tempfile.NamedTemporaryFile(
            delete=False, suffix=".md", mode="w+", encoding="utf-8"
        )
        tmp_md.close()
        try:
            pypandoc.convert_file(
                path,
                "gfm",
                outputfile=tmp_md.name,
                extra_args=[f"--extract-media={media_base}"],
            )
            with open(tmp_md.name, "r", encoding="utf-8") as f:
                raw_md = f.read()
        finally:
            try:
                os.unlink(tmp_md.name)
            except OSError:
                pass
        # 生成自包含 HTML（图片 base64 内嵌，无下载入口）
        # --standalone 产出完整文档，需剥离 <html><head><body> 壳，
        # 避免 <style> 标签污染页面布局
        try:
            full_html = pypandoc.convert_file(
                path, "html5", extra_args=["--embed-resources", "--standalone", "--wrap=none"]
            )
            body_match = re.search(r'<body[^>]*>(.*)</body>', full_html, re.DOTALL)
            html_content = body_match.group(1) if body_match else full_html
        except Exception:
            html_content = ""
        # 收集被提取的图片
        images = []
        if os.path.isdir(media_base):
            for i, fn in enumerate(sorted(os.listdir(media_base))):
                fp = os.path.join(media_base, fn)
                if os.path.isfile(fp):
                    images.append(
                        ImageInfo(original_name=fn, stored_path=fp, position=i)
                    )

    # 后处理 + 分段 + 类型标记
    md = html_table_to_markdown(normalize_markdown(raw_md))  # 2026-08-06：HTML <table> → 竖线/字段值文本，避免标签稀释检索
    # 无 markdown 标题标记时（Word 未用内置标题样式），用启发式识别疑似标题（中英文）
    inferred = False
    if not has_any_heading(md):
        md_inferred = infer_headings(md)
        if md_inferred != md:
            md = md_inferred
            inferred = True
    segs = split_segments(md)
    segments: list[Segment] = []
    cover_zone = True
    for i, s in enumerate(segs):
        stype = s.get("type", "body")
        # cover 仅在首部连续段落判定；一旦进入 body 不再标 cover
        if stype == "body":
            cover_zone = False
        segments.append(
            Segment(
                index=i,
                text=s["text"],
                lang=detect_lang(s["text"]),
                type=stype if stype != "body" else "body",
            )
        )

    # 质量自检：标题数≥1 且有正文段 => ok；无标题且未推断出 → need_review
    has_body = any(s.type == "body" for s in segments)
    quality = "ok" if (has_body and len(segments) >= 1) else "need_review"
    if not has_any_heading(md):
        quality = "need_review"  # 全文无标题（含启发式也未识别出）→ 提示人工检查切片

    return ConvertResponse(
        markdown=md,
        html=html_content,
        segments=segments,
        images=images,
        quality=quality,
    )