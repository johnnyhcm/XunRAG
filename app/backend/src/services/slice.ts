// 段落 + 切分线模型（PRD §4.2.2 + S3 决策 2026-08-04）
// - 纯标题段（仅一行 heading）：retained=false，不入库也不并入下一 chunk
//   但其标题文本作为后续 chunk 的 section_path 上下文
// - 每个 chunk 带 section_path（如 "第二章 > 第三条"）：检索命中能说清所属章节
import type { ConvertSegment } from './convert.js';

export interface SliceSegment {
  index: number;
  text: string;
  lang: string;
  type: 'body' | 'cover' | 'toc' | 'header_footer';
  level: 'H1' | 'H2' | 'H3' | '';
  has_table: boolean;
  tokens: number;
  retained: boolean;    // 是否进向量库；纯标题/cover/toc 默认 false
  isPureHeading: boolean; // 仅含一行 heading
}

export interface SlicePlan {
  segments: SliceSegment[];
  splits: boolean[];    // splits[i]=true 表示第 i 段之前有切分线；splits[0] 恒 false
}

const HEADING = /^(#{1,3})\s+(.+?)\s*$/;

const countTokens = (text: string): number => {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (text.match(/[a-zA-Z]+/g) || []).length;
  return cjk + Math.round(words * 1.5);
};

/** 判断段落是否仅含一行 heading（无其他非空正文行） */
function isPureHeading(text: string): boolean {
  const lines = text.trim().split('\n').filter((l) => l.trim());
  return lines.length === 1 && HEADING.test(lines[0]);
}

/** 从 heading 行提取标题文本（去 # 前缀） */
function headingText(line: string): string | null {
  const m = line.match(HEADING);
  return m ? m[2] : null;
}

/** 规则切分：每段一个 segment；heading 段之前加切分线（首段除外）；纯标题默认保留（作为检索前缀） */
export function sliceByRule(segments: ConvertSegment[]): SlicePlan {
  const out: SliceSegment[] = [];
  const splits: boolean[] = [];
  let idx = 0;
  for (const s of segments) {
    const m = s.text.match(HEADING);
    const isHeading = !!m && s.type === 'body';
    const level = isHeading ? (`H${m![1].length}` as SliceSegment['level']) : '';
    const pure = isHeading && isPureHeading(s.text);
    // retained：cover / toc / header_footer 默认 false；body 段（含标题段）true——
    // 标题段作为检索词并入所属 chunk 的 content 前缀（方案 A：标题词参与向量/BM25 检索）
    const retained = s.type === 'body';
    out.push({
      index: idx,
      text: s.text,
      lang: s.lang,
      type: s.type,
      level,
      has_table: /\n\s*\|.*\|.*\n\s*\|[\s:|-]+\|/.test(s.text) || s.text.includes('\n|'),
      tokens: countTokens(s.text),
      retained,
      isPureHeading: pure,
    });
    // 切分线：首个段之前无切分线；其后每个 heading 段之前有切分线
    // （纯标题段也加切分线——它自成一段但不入库，作为后续 chunk 的 section_path 上下文）
    splits.push(idx === 0 ? false : isHeading);
    idx++;
  }
  return { segments: out, splits };
}

export interface AggregatedChunk {
  chunk_index: number;
  content: string;        // 含保留标题前缀（方案 A：标题词参与检索）
  level: 'H1' | 'H2' | 'H3' | '';
  has_table: boolean;
  retained: boolean;
  type: 'body' | 'cover' | 'toc' | 'header_footer';
  segment_indices: number[];
  section_path: string;   // 该 chunk 所属章节路径（从最近前置 heading 推导）
}

/** 聚合：两切分线之间的保留段落 = 1 chunk；维护 section_path（heading 栈）
 *  纯标题段不进 segment_indices，但 retained=true 时并入 content 开头作为检索前缀（方案 A） */
export function aggregateChunks(plan: SlicePlan): AggregatedChunk[] {
  const chunks: AggregatedChunk[] = [];
  let cur: number[] = [];
  let curLevel: AggregatedChunk['level'] = '';
  // heading 栈：section_path 用全部标题；content 前缀只含 retained 标题
  const headingStack: { level: number; text: string }[] = [];
  const contentStack: { level: number; text: string }[] = [];

  const currentPath = (): string => headingStack.map((h) => h.text).join(' > ');
  const contentPrefix = (): string => contentStack.map((h) => h.text).join(' > ');

  const pushHeading = (level: number, text: string, retained: boolean) => {
    // 弹出同级或更深的 heading
    while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
      headingStack.pop();
    }
    headingStack.push({ level, text });
    // contentStack 同步维护（仅 retained 标题参与检索前缀）
    while (contentStack.length && contentStack[contentStack.length - 1].level >= level) {
      contentStack.pop();
    }
    if (retained) contentStack.push({ level, text });
  };

  const flush = () => {
    if (cur.length === 0) return;
    const segs = cur.map((i) => plan.segments[i]);
    const body = segs.map((s) => s.text).join('\n\n');
    const prefix = contentPrefix();
    let content;
    // 独立标题块：仅标题文本（避免前缀重复）
    if (segs.length === 1 && segs[0].isPureHeading) {
      content = segs[0].text.replace(/^#{1,3}\s+/, '').trim();
    } else {
      content = prefix ? `${prefix}\n\n${body}` : body;
    }
    const first = segs[0];
    chunks.push({
      chunk_index: chunks.length,
      content,
      level: curLevel,
      has_table: segs.some((s) => s.has_table),
      retained: segs.some((s) => s.retained),
      type: first.type,
      segment_indices: [...cur],
      section_path: currentPath(),
    });
    cur = [];
  };

  for (let i = 0; i < plan.segments.length; i++) {
    if (plan.splits[i]) {
      flush();
      curLevel = '';
    }
    const seg = plan.segments[i];
    // 纯标题段：更新 section_path；retained=true 时并入 content 前缀（作为检索词）
    // 若标题段后也有切分线（用户手动切分）→ 独立成块进 cur（下一 flush 成独立 chunk）
    if (seg.isPureHeading) {
      const hText = headingText(seg.text);
      if (hText && seg.level) {
        pushHeading(Number(seg.level.replace('H', '')), hText, seg.retained);
      }
      if (plan.splits[i + 1]) {
        cur.push(i);
      }
      continue;
    }
    if (seg.level && !curLevel) curLevel = seg.level;
    cur.push(i);
  }
  flush();
  return chunks;
}

export function slugify(heading: string): string {
  return heading.replace(/^#+\s*/, '').replace(/[（(].*?[)）]/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'section';
}
/** 切片锚点（2026-08-13 回填文本层）：section_path 末段 slug，与 ingest slugAnchor/parseAnchors 同源 */
export function chunkAnchor(sectionPath: string): string {
  const last = (sectionPath.split(' > ').pop() || sectionPath).trim();
  return slugify(last) || 'section';
}

/** token 估算（2026-08-13，中文为主近似）：用于 policy_chunks.token_count 与技术详情 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil((text || '').length / 1.6));
}
