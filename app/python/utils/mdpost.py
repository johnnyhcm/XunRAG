"""Markdown 后处理 + 分段 + 类型标记（D2 决策）

- 规范化：去除 pandoc 转义（数字列表、破折号等）
- grid table → pipe table（pandoc gfm 输出可能含 grid table）
- 按段落（空行分隔）切 segment
- 类型标记：
  - cover：首部连续短段，含标题/编号/部门/日期特征
  - toc：段含"目录/目 录"或连续多行"标题 ... 页码"
  - header_footer：极短且重复出现的（兜底，pandoc 通常已丢）
  - body：其余
"""
import re


# ============ 疑似标题识别（无 markdown 标题标记时兜底，中英文） ============
# 规则覆盖常见制度文档写法：第X章/第X条/一、二、/（一）（二）/ Chapter X / Article X / 加粗短句
_CN_CHAPTER = re.compile(r"^第[一二三四五六七八九十百千零〇\d]+[章节篇]\s*")
_CN_SECTION = re.compile(r"^第[一二三四五六七八九十百千零〇\d]+[条款]\s*")
_CN_NUM = re.compile(r"^[一二三四五六七八九十]+、")
_CN_BRACKET = re.compile(r"^[（(][一二三四五六七八九十]+[)）]")
_EN_CHAPTER = re.compile(r"^(Chapter|Part)\s+[\dIVXLC]+[.:]?\s*", re.I)
_EN_SECTION = re.compile(r"^(Article|Section|Clause|Appendix|Annex)\s+[\dIVXLC]+[.:]?\s*", re.I)
_EN_ROMAN = re.compile(r"^[IVXLC]+\.\s+[A-Z]")
_BOLD = re.compile(r"^\*\*(.+?)\*\*$")
# 加粗短段转标题的约束：去粗后 ≤50 字符、不以句号结尾（避免正文加粗句误伤）
_SENTENCE_END = re.compile(r"[。！？．!?]$")


def _heading_level(text: str) -> str | None:
    """返回该文本应匹配的标题级别 H1/H2/H3；不匹配返回 None"""
    t = text.strip()
    if _CN_CHAPTER.match(t) or _EN_CHAPTER.match(t):
        return "H1"
    if _CN_SECTION.match(t) or _EN_SECTION.match(t) or _CN_NUM.match(t):
        return "H2"
    if _CN_BRACKET.match(t):
        return "H3"
    return None


def infer_headings(md: str) -> str:
    """对无 markdown 标题标记（#）的文档，用启发式规则把疑似标题段落加 # 标记。
    只处理整段单行；段落内嵌文本不影响。返回补全标题后的 markdown。"""
    out_lines: list[str] = []
    for line in md.split("\n"):
        s = line.strip()
        if not s or s.startswith("#"):
            out_lines.append(line)
            continue
        # 加粗短段 → 标题（如 **第一章 总则** / **Introduction**）
        bm = _BOLD.match(s)
        if bm:
            inner = bm.group(1).strip()
            if len(inner) <= 50 and not _SENTENCE_END.search(inner):
                lvl = _heading_level(inner) or "H2"
                out_lines.append(f"{'#' * int(lvl[1:])} {inner}")
                continue
        # 编号模式（纯文本，无加粗）
        lvl = _heading_level(s)
        if lvl and len(s) <= 60:
            out_lines.append(f"{'#' * int(lvl[1:])} {s}")
            continue
        # 英文罗马数字序号（I. II. III.）→ 标题
        if _EN_ROMAN.match(s) and len(s) <= 60:
            out_lines.append(f"### {s}")
            continue
        out_lines.append(line)
    return "\n".join(out_lines)


def has_any_heading(md: str) -> bool:
    """全文是否存在 markdown 标题标记"""
    return any(re.match(r"^#{1,3}\s+", line) for line in md.split("\n"))


# pandoc 转义规范化
def normalize_markdown(md: str) -> str:
    # 数字列表转义：1\. → 1.
    md = re.sub(r"(\d+)\\\.", r"\1.", md)
    # 连续破折号转义：\-\-\- → ---
    md = md.replace(r"\-\-\-", "---")
    # 列表项转义：\- → -
    md = re.sub(r"(?m)^\\- ", "- ", md)
    # 多余空行压缩
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md.strip() + "\n"


# ============ HTML 表格 → 干净文本（2026-08-06：pandoc 对复杂 Word 表格输出 <table>，直接入库会劣化检索） ============
_HTML_TABLE = re.compile(r"<table[^>]*>.*?</table>", re.S)
_HTML_ROW = re.compile(r"<(?:tr|th)[^>]*>(.*?)</(?:tr|th)>", re.S)
_HTML_CELL = re.compile(r"<(?:td|th)[^>]*>(.*?)</(?:td|th)>", re.S)
_HTML_TAG = re.compile(r"<[^>]+>")
_HTML_ENT = {"&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'"}


def _clean_cell(text: str) -> str:
    """单元格清洗：<br> → 分隔符、去标签、解 HTML 实体、压缩空白"""
    text = re.sub(r"<br\s*/?>", " / ", text, flags=re.I)
    text = _HTML_TAG.sub("", text)
    for k, v in _HTML_ENT.items():
        text = text.replace(k, v)
    return re.sub(r"\s+", " ", text).strip()


def html_table_to_markdown(md: str) -> str:
    """把 pandoc 输出的 <table> HTML 转成可检索文本。
    - 列数一致的简单表格 → Markdown 竖线表格（与差旅/考勤等正常表格一致，检索友好）；
    - 列数不一致/合并单元格的复杂表格 → 降级为"字段：值"文本行（D2 决策"复杂表格降级为列表"）；
    - 中英双语单元格保留两边文字（" / " 分隔），中英文均参与检索；
    - 段粒度不变：多行输出之间仅单换行（无空行），split_segments 仍视为一个段，不破坏已确认切片边界。
    """
    def conv(m: re.Match) -> str:
        block = m.group(0)
        table: list[list[str]] = []
        for row in _HTML_ROW.findall(block):
            cells = [_clean_cell(c) for c in _HTML_CELL.findall(row)]
            cells = [c for c in cells if c]
            if cells:
                table.append(cells)
        if not table:
            return ""
        widths = {len(r) for r in table}
        if len(widths) == 1:  # 列数一致 → 竖线表格
            n = len(table[0])
            lines = ["| " + " | ".join(table[0]) + " |"]
            lines.append("| " + " | ".join(["---"] * n) + " |")
            lines.extend("| " + " | ".join(r) + " |" for r in table[1:])
            return "\n".join(lines)
        # 复杂表格 → 字段：值 文本行（每行独立可检索）
        return "\n".join("；".join(r) for r in table)

    return _HTML_TABLE.sub(conv, md)


# 位置约束：只在前 N 段判 toc（目录必在文档前部）
_TOC_MAX_SEGMENT_INDEX = 8

# 判断是否目录段（强信号 + 位置约束，见 _is_toc）
_TOC_DOTPAGE = re.compile(r"^\s*\S.{0,30}?\s*\.{3,}\s*\d{1,4}\s*$")
_TOC_MDLINK = re.compile(r"^\s*\[[^\]]+\]\([^)]+\)\s*$")
_TOC_CHAP_PAGE = re.compile(r"^\s*第[一二三四五六七八九十百零\d]+[章节条].{0,30}?\s+\d{1,4}\s*$")
_TOC_TITLE = re.compile(r"^#{0,6}\s*目\s*录\s*$")


def _is_toc(text: str) -> bool:
    """强信号 + 整段一致性，宁可漏标不误伤正文。"""
    lines = [l.rstrip() for l in text.strip().splitlines() if l.strip()]
    if len(lines) < 2:
        return False
    # 1) 纯标题“# 目录 / # 目 录”
    if _TOC_TITLE.match(text.strip()):
        return True
    # 2) “标题 .... 页码”点号引导：整段一致（≥60% 行匹配）
    dotpage_hits = sum(1 for l in lines if _TOC_DOTPAGE.match(l))
    if len(lines) >= 2 and dotpage_hits >= max(2, int(len(lines) * 0.6)):
        return True
    # 3) markdown 链接索引：每行都是“文字”（#anchor/url）
    link_hits = sum(1 for l in lines if _TOC_MDLINK.match(l))
    if len(lines) >= 3 and link_hits >= int(len(lines) * 0.8):
        return True
    # 4) “第X章 标题  页码”型：整段一致
    cp_hits = sum(1 for l in lines if _TOC_CHAP_PAGE.match(l))
    if len(lines) >= 3 and cp_hits >= int(len(lines) * 0.8):
        return True
    return False


# 封面特征：标题（# 开头）、制度编号、部门名、日期
_COVER_HINT = re.compile(
    r"(第[一二三四五六七八九十百零\d]+[章节条编号]|"
    r"制度|办法|规定|细则|通知|条例|"
    r"\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|"
    r"人力资源部|行政部|财务部|法务部|总经办|公司|集团)"
)
_PURE_TITLE = re.compile(r"^#{1,3}\s+\S")


def _is_cover(text: str, cover_zone: bool) -> bool:
    if not cover_zone:
        return False
    lines = [l for l in text.strip().splitlines() if l.strip()]
    if not lines:
        return False
    # 纯标题段
    if _PURE_TITLE.match(text.strip()):
        return True
    # 封面特征段（编号/部门/日期/版本标签）：短段、不含句号结尾、含封面关键词
    # 收紧阈值（60→30 + 排除句号结尾），避免“第一条…制定本制度。”等正文段被误判为封面丢弃
    last_char = text.strip()[-1] if text.strip() else ""
    if last_char in "。！？．!?":
        return False
    max_len = max((len(l.strip()) for l in lines), default=0)
    if max_len <= 30 and _COVER_HINT.search(text):
        return True
    return False


def split_segments(md: str) -> list[dict]:
    """按空行切段，标记 type。返回 [{text, type}]"""
    blocks = re.split(r"\n\s*\n", md)
    segs: list[dict] = []
    cover_zone = True
    last_short_text = None
    for i, b in enumerate(blocks):
        b = b.strip()
        if not b:
            continue
        stype = "body"
        # 位置约束：只在前 N 段才判 toc（目录必在文档前部）
        if i < _TOC_MAX_SEGMENT_INDEX and _is_toc(b):
            stype = "toc"
            cover_zone = False  # 目录后不再视作封面
        elif _is_cover(b, cover_zone):
            stype = "cover"
        else:
            cover_zone = False
        # 重复短行 → header_footer 兜底
        if len(b) <= 30 and b == last_short_text:
            stype = "header_footer"
        last_short_text = b if len(b) <= 30 else None
        segs.append({"text": b, "type": stype})
    return segs