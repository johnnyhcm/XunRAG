// 政策检索服务（高效/智能模式共享，PRD §4.4.2）
// 内部调 Python /search（BM25+向量 RRF 融合 + rerank）
import { config } from '../config.js';
import { getNumber, getConfig } from './config.js';
import { getEffectiveVersionIds } from '../db/repo.js';

export interface SearchHit {
  id: string;
  content: string;
  source: string;
  section: string;
  anchor: string;
  has_table: boolean;
  score: number;
  line_id: string;
}

export interface SearchResult {
  results: SearchHit[];
  raw: any;
  tookMs: number;
}

/** 调 Python /search（高效/智能模式复用同一检索链路；visibleLineIds=S6 权限可见集合，过滤 file_id）
 *  applicableLineIds/inapplicableLineIds：适用范围软排序（2026-08-12）——Python rerank 后按 line_id 加权 */
export async function searchPolicies(query: string, topK?: number, visibleLineIds?: string[], applicableLineIds?: Set<string>, inapplicableLineIds?: Set<string>, language?: string): Promise<SearchResult> {
  const k = topK ?? getNumber('efficient.retrieve.top_k', 5);
  const t0 = Date.now();
  const eff = getEffectiveVersionIds();
  // 2026-08-08 诊断：记录检索实际参数（排查"身份正常但拒答"）
  console.log(`[search-diag] query="${query.slice(0, 20)}" file_ids=${visibleLineIds?.length ?? '不限'} effective_versions=${eff.length} applicable=${applicableLineIds?.size ?? 0} inapplicable=${inapplicableLineIds?.size ?? 0}`);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), getNumber('efficient.retrieve.timeout_ms', 30_000));
  try {
    const res = await fetch(`${config.pythonBaseUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        top_k: k,
        // 生效版本集合（2026-08-06 方案 B）：每次动态计算（published+生效区间(服务器时区)+库 active），
        // 入库时机与生效判断解耦——发布未来版本不提前可检索、版本到期自动切换
        effective_version_ids: eff,
        // S6 权限：可见集合硬过滤（file_id IN，防探测装不存在）；空数组=过滤到空（无可见政策），undefined=不限（内部/兼容）
        file_ids: visibleLineIds !== undefined ? visibleLineIds : undefined,
        // 适用范围软排序（2026-08-12）：applicable 加权 ×(1+α)，inapplicable ×(1-β)；neutral/无规则=×1
        applicable_line_ids: applicableLineIds ? [...applicableLineIds] : undefined,
        inapplicable_line_ids: inapplicableLineIds ? [...inapplicableLineIds] : undefined,
        applicable_boost: getNumber('efficient.retrieve.applicable_boost', 0.3),
        inapplicable_penalty: getNumber('efficient.retrieve.inapplicable_penalty', 0.15),
        // 语言软排序（2026-08-13）：提问语言匹配切片加权，不匹配降权
        language,
        language_boost: getNumber('efficient.retrieve.language_boost', 0.1),
        language_penalty: getNumber('efficient.retrieve.language_penalty', 0.1),
        // 检索参数按请求传递（配置中心，2026-08-06）：开关/候选数/RRF k/BM25 k1,b
        hybrid: getConfig('efficient.retrieve.hybrid', '1') === '1',
        rerank: getConfig('efficient.retrieve.rerank', '1') === '1',
        fused_candidates: getNumber('efficient.retrieve.fused_candidates', 20),
        rrf_k: getNumber('efficient.retrieve.rrf_k', 60),
        bm25_k1: getNumber('efficient.retrieve.bm25_k1', 1.5),
        bm25_b: getNumber('efficient.retrieve.bm25_b', 0.75),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Python /search ${res.status}`);
    const raw = await res.json();
    const n = (raw.results ?? []).length;
    // 2026-08-08 加固：检索失败/空结果记日志（此前静默拒答无法排查）
    if (!n) console.log(`[search-diag] ⚠️ Python 返回空结果（query="${query.slice(0, 20)}" file_ids=${visibleLineIds?.length ?? '不限'} eff=${eff.length}）`);
    return { results: raw.results ?? [], raw, tookMs: Date.now() - t0 };
  } catch (e: any) {
    console.error(`[search-diag] ❌ Python /search 失败（query="${query.slice(0, 20)}"）: ${e?.message ?? e}`);
    throw e;
  } finally { clearTimeout(t); }
}