"""语言检测（P7 方案：按段 + 字符集比例）

- CJK 比例 > 60% → zh
- Latin 比例 > 60% → en
- 其余 → mixed
零依赖，纯字符集统计。
"""
import unicodedata


def _char_class(ch: str) -> str:
    cp = ord(ch)
    # CJK 统一表意文字 + 扩展 A + 兼容 ideograph
    if (
        0x4E00 <= cp <= 0x9FFF
        or 0x3400 <= cp <= 0x4DBF
        or 0xF900 <= cp <= 0xFAFF
        or 0x3040 <= cp <= 0x30FF  # 平假名/片假名（日文也按 CJK 区记 zh）
    ):
        return "cjk"
    if ch.isalpha():
        return "latin"
    return "other"


def detect_lang(text: str) -> str:
    if not text or not text.strip():
        return "zh"  # 空段默认 zh（政策文档主语言）
    cjk = latin = 0
    for ch in text:
        cls = _char_class(ch)
        if cls == "cjk":
            cjk += 1
        elif cls == "latin":
            latin += 1
    total = cjk + latin
    if total == 0:
        return "zh"
    if cjk / total > 0.6:
        return "zh"
    if latin / total > 0.6:
        return "en"
    return "mixed"