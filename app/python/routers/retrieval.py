"""S3 检索栈路由（PRD §4.4 / TECH.md §3.3）

端点：
  POST /embed   {texts:[str]}                      → {embeddings:[[float]]}
  POST /index   {chunks:[{id,content,metadata}]}   → 入 Chroma + BM25 索引
  POST /search  {query, top_k?, file_ids?}         → 混合检索 + rerank → Top-K
  POST /rerank  {query, candidates:[{id,content}]} → {ranked:[{id,score}]}
  GET  /health                                   → 模型加载状态

模型（lazy load，首次调用触发；启动不阻塞）：
  bge-m3          -> SentenceTransformer(models/embedding/bge-m3)
  bge-reranker    -> CrossEncoder(models/reranker/bge-reranker-v2-m3)
混合检索：BM25(jieba+rank_bm25 内存) Top-20 + 向量(Chroma) Top-20 → RRF(k=60) → Top-20_fused
  → rerank(bge-reranker, max_len=256, batch) → Top-K_final（K 默认 5，可 env 配置）
检索开关（TECH.md §3.3 / PRD §4.4.2，S3 默认全开，env 可关）：
  POLICYBOT_HYBRID=1   (1=BM25+向量双路；0=纯向量)
  POLICYBOT_RERANK=1   (1=精排；0=跳过)
  POLICYBOT_TOPK=5
Chroma 持久化：data/vector-db/
"""
import os
import math
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

# ---- 配置 ----
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
EMBED_MODEL_PATH = os.path.join(ROOT, "models", "embedding", "bge-m3")
RERANKER_MODEL_PATH = os.path.join(ROOT, "models", "reranker", "bge-reranker-v2-m3")
# 2026-08-11：测试环境隔离——POLICYBOT_CHROMA_PATH 可覆盖索引路径（与 SQLITE_PATH 对称）；
#   涉及文件/切片/入库的自动测试必须设此 env 指向临时索引目录，禁止写正式 data/vector-db
CHROMA_PATH = os.getenv("POLICYBOT_CHROMA_PATH") or os.path.join(ROOT, "data", "vector-db")
COLLECTION_NAME = "policy_chunks"

HYBRID = os.getenv("POLICYBOT_HYBRID", "1") == "1"
RERANK = os.getenv("POLICYBOT_RERANK", "1") == "1"
TOP_K = int(os.getenv("POLICYBOT_TOPK", "5"))

# ---- 模型与索引单例（lazy） ----
_embed_model = None
_reranker_model = None
_chroma_client = None
_collection = None
_bm25 = None
_bm25_docs = []  # [{id, content, file_id, version_id}]
_jieba_ready = False


def _jieba():
    global _jieba_ready
    if not _jieba_ready:
        import jieba
        jieba.setLogLevel(20)
        _jieba_ready = True
    return __import__("jieba")


def _check_model_dir(model_path: str, name: str):
    """模型未下载时给出明确错误（防呆：避免检索静默空结果被误判为 bug）"""
    if not os.path.isdir(model_path) or not os.path.exists(os.path.join(model_path, 'config.json')):
        raise HTTPException(
            status_code=500,
            detail=f'{name} 未下载（{model_path}）。请先运行：python tools/download_models.py（约 6.5GB）',
        )


def _embedder():
    global _embed_model
    if _embed_model is None:
        _check_model_dir(EMBED_MODEL_PATH, '向量模型 bge-m3')
        from sentence_transformers import SentenceTransformer
        print(f"[python] loading bge-m3 from {EMBED_MODEL_PATH}")
        _embed_model = SentenceTransformer(EMBED_MODEL_PATH)
    return _embed_model


def _reranker():
    global _reranker_model
    if _reranker_model is None:
        _check_model_dir(RERANKER_MODEL_PATH, '精排模型 bge-reranker-v2-m3')
        from sentence_transformers import CrossEncoder
        print(f"[python] loading bge-reranker from {RERANKER_MODEL_PATH}")
        _reranker_model = CrossEncoder(RERANKER_MODEL_PATH, max_length=256)
    return _reranker_model


def _collection_get():
    global _chroma_client, _collection
    if _collection is None:
        import chromadb
        os.makedirs(CHROMA_PATH, exist_ok=True)
        _chroma_client = chromadb.PersistentClient(path=CHROMA_PATH)
        _collection = _chroma_client.get_or_create_collection(name=COLLECTION_NAME, metadata={"hnsw:space": "cosine"})
    return _collection


def _rebuild_bm25():
    global _bm25, _bm25_docs
    if not _bm25_docs:
        _bm25 = None
        return
    from rank_bm25 import BM25Okapi
    jieba = _jieba()
    tokenized = [list(jieba.cut(d["content"])) for d in _bm25_docs]
    _bm25 = BM25Okapi(tokenized)


def _set_bm25_params(k1: float, b: float):
    """动态调整 BM25 k1/b（rank_bm25 的 BM25Okapi 实例属性可改，无需重建索引）"""
    global _bm25
    if _bm25 is not None:
        _bm25.k1 = k1
        _bm25.b = b


def _restore_bm25_from_chroma():
    """重启后从持久化 Chroma 重建 BM25 内存索引（Chroma 持久化而 BM25 是内存态，
    否则重启后混合检索静默退化为纯向量）。Chroma 无数据或已重建则跳过。"""
    global _bm25, _bm25_docs
    if _bm25 is not None:
        return
    try:
        col = _collection_get()
        cnt = col.count()
        if cnt == 0:
            return
        # 分批拉全量（id + content + file_id + version_id）
        docs: list[dict] = []
        offset = 0
        batch = 2000
        while offset < cnt:
            res = col.get(limit=batch, offset=offset, include=["documents", "metadatas"])
            ids = res.get("ids") or []
            documents = res.get("documents") or []
            metas = res.get("metadatas") or []
            for i, cid in enumerate(ids):
                docs.append({
                    "id": cid,
                    "content": documents[i] if i < len(documents) else "",
                    "file_id": (metas[i] or {}).get("file_id") if i < len(metas) else None,
                    "version_id": (metas[i] or {}).get("version_id") if i < len(metas) else None,
                })
            offset += batch
        _bm25_docs = docs
        _rebuild_bm25()
        print(f"[python] BM25 已从 Chroma 重建（{len(docs)} docs）")
    except Exception as e:
        print(f"[python] BM25 重建失败（将仅向量检索）: {e}")
        _bm25_docs = []
        _bm25 = None


# ---- 请求/响应模型 ----
class EmbedReq(BaseModel):
    texts: list[str]


class IndexChunk(BaseModel):
    id: str
    content: str
    metadata: dict = {}


class IndexReq(BaseModel):
    chunks: list[IndexChunk]


class SearchReq(BaseModel):
    query: str
    top_k: Optional[int] = None
    file_ids: Optional[list[str]] = None
    # 生效版本集合（2026-08-06 方案 B）：Node 每次动态计算传入，向量/BM25 双路过滤；None=不过滤
    effective_version_ids: Optional[list[str]] = None
    # 适用范围软排序（2026-08-12）：applicable 加权 ×(1+boost) / inapplicable ×(1-penalty)；neutral/无规则=×1
    applicable_line_ids: Optional[list[str]] = None
    inapplicable_line_ids: Optional[list[str]] = None
    applicable_boost: Optional[float] = None
    inapplicable_penalty: Optional[float] = None
    # 语言软排序（2026-08-13）：提问语言匹配的切片加权，不匹配降权（软加权，不硬过滤）
    language: Optional[str] = None
    language_boost: Optional[float] = None
    language_penalty: Optional[float] = None
    # 检索参数（2026-08-06：配置中心按请求覆盖 env/默认值；None=用系统默认）
    hybrid: Optional[bool] = None
    rerank: Optional[bool] = None
    fused_candidates: Optional[int] = None
    rrf_k: Optional[int] = None
    bm25_k1: Optional[float] = None
    bm25_b: Optional[float] = None


class RerankReq(BaseModel):
    query: str
    candidates: list[dict]  # [{id, content}]


# ---- /embed ----
@router.post("/embed")
def embed(req: EmbedReq):
    model = _embedder()
    embs = model.encode(req.texts, normalize_embeddings=True, convert_to_numpy=True)
    return {"embeddings": embs.tolist()}


# ---- /index ----（Node 入库时调用）
@router.post("/index")
def index_chunks(req: IndexReq):
    if not req.chunks:
        return {"indexed": 0}
    # 1) Chroma 入库
    col = _collection_get()
    ids = [c.id for c in req.chunks]
    docs = [c.content for c in req.chunks]
    metas = [c.metadata for c in req.chunks]
    # embed（bge-m3）
    model = _embedder()
    embs = model.encode(docs, normalize_embeddings=True, convert_to_numpy=True)
    # 先删同 id（幂等）
    try:
        col.delete(ids=ids)
    except Exception:
        pass
    col.add(ids=ids, embeddings=embs.tolist(), documents=docs, metadatas=metas)
    # 2) BM25 内存索引维护（按 version_id 先删再加；方案 B 多版本共存，删除粒度=版本）
    version_ids = set(m.get("version_id") for m in metas if m.get("version_id"))
    global _bm25_docs
    if version_ids:
        _bm25_docs = [d for d in _bm25_docs if d.get("version_id") not in version_ids]
    for c in req.chunks:
        _bm25_docs.append({"id": c.id, "content": c.content, "file_id": c.metadata.get("file_id"), "version_id": c.metadata.get("version_id")})
    _rebuild_bm25()
    return {"indexed": len(req.chunks), "bm25_docs": len(_bm25_docs)}


@router.delete("/index/{file_id}")
def delete_file(file_id: str):
    """按 line 删向量（强制清理/删库用）——2026-08-07 修复（ISSUE #33 根治）：删除失败必须显性化
    （原 except: pass 静默吞错 → Node 侧永远 200 → 孤儿向量残留且不可见）"""
    col = _collection_get()
    try:
        col.delete(where={"file_id": file_id})
    except Exception as e:
        print(f"[python] delete file {file_id} failed: {e}")
        raise HTTPException(status_code=500, detail=f"delete file {file_id} failed: {e}")
    global _bm25_docs
    _bm25_docs = [d for d in _bm25_docs if d.get("file_id") != file_id]
    _rebuild_bm25()
    return {"deleted_file": file_id, "bm25_docs": len(_bm25_docs)}


@router.delete("/index/version/{version_id}")
def delete_version(version_id: str):
    """按版本删向量（2026-08-06 方案 B）：废止/删除版本时调用；Chroma 多版本共存，删除粒度=版本
    2026-08-07 修复（ISSUE #33 根治）：删除失败显性化（原 except: pass 静默）——失败抛 500，Node 侧记日志可见"""
    col = _collection_get()
    try:
        col.delete(where={"version_id": version_id})
    except Exception as e:
        print(f"[python] delete version {version_id} failed: {e}")
        raise HTTPException(status_code=500, detail=f"delete version {version_id} failed: {e}")
    global _bm25_docs
    _bm25_docs = [d for d in _bm25_docs if d.get("version_id") != version_id]
    _rebuild_bm25()
    return {"deleted_version": version_id, "bm25_docs": len(_bm25_docs)}


@router.get("/index/version-ids")
def list_version_ids():
    """返回 Chroma 中所有不重复的 version_id（2026-08-06：Node 启动一致性校验用）"""
    col = _collection_get()
    ids = set()
    try:
        all_data = col.get(include=["metadatas"])
        for m in (all_data.get("metadatas") or []):
            vid = (m or {}).get("version_id")
            if vid:
                ids.add(vid)
    except Exception:
        pass
    return {"version_ids": list(ids)[:5000]}


@router.get("/index/line-ids")
def list_line_ids():
    """返回 Chroma 中所有不重复的 line_id（供 Node 启动同步用）"""
    col = _collection_get()
    ids = set()
    try:
        # 分页取（Chroma get 默认上限 1000，分批拉）
        all_data = col.get(include=["metadatas"])
        for m in (all_data.get("metadatas") or []):
            lid = (m or {}).get("line_id")
            if lid:
                ids.add(lid)
    except Exception:
        pass
    return {"line_ids": list(ids)[:5000]}


# ---- /search ----
@router.post("/search")
def search(req: SearchReq):
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="query 必填")
    k = req.top_k or TOP_K
    # 配置中心按请求覆盖（2026-08-06）：None=用 env/默认
    hybrid = HYBRID if req.hybrid is None else req.hybrid
    rerank = RERANK if req.rerank is None else req.rerank
    fused_n = (req.fused_candidates or 20) if req.fused_candidates else 20
    rrf_k = (req.rrf_k or 60) if req.rrf_k else 60
    bm25_k1 = (req.bm25_k1 or 1.5) if req.bm25_k1 else 1.5
    bm25_b = (req.bm25_b or 0.75) if req.bm25_b else 0.75
    # 适用范围软排序（2026-08-12）：加权系数与命中集合；空集合=全中性（不加不减）
    boost = (req.applicable_boost or 0.3) if req.applicable_boost else 0.3
    penalty = (req.inapplicable_penalty or 0.15) if req.inapplicable_penalty else 0.15
    lang = req.language
    lang_boost = (req.language_boost or 0.1) if req.language_boost else 0.1
    lang_penalty = (req.language_penalty or 0.1) if req.language_penalty else 0.1
    applicable_set = set(req.applicable_line_ids or [])
    inapplicable_set = set(req.inapplicable_line_ids or [])
    # 权限过滤（file_id IN 可见集合；S6 实际生效，S3 空集合=全员可见）+ 生效版本过滤（方案 B，2026-08-06）
    conds = []
    if req.file_ids is not None:
        conds.append({"file_id": {"$in": req.file_ids}})
    if req.effective_version_ids is not None:
        conds.append({"version_id": {"$in": req.effective_version_ids}})
    where = {"$and": conds} if len(conds) > 1 else (conds[0] if conds else None)

    bm25_top20 = []
    vector_top20 = []

    # ---- 向量路 ----
    col = _collection_get()
    model = _embedder()
    qemb = model.encode([req.query], normalize_embeddings=True, convert_to_numpy=True)[0].tolist()
    try:
        vr = col.query(query_embeddings=[qemb], n_results=fused_n, where=where)
        for i, cid in enumerate(vr["ids"][0]):
            vector_top20.append({
                "id": cid,
                "score": 1.0 - float(vr["distances"][0][i]),  # cosine 距离转相似
                "content": vr["documents"][0][i],
                "metadata": vr["metadatas"][0][i],
            })
    except Exception as e:
        print(f"[python] vector search err: {e}")

    # ---- BM25 路（内存索引缺失时先从 Chroma 重建）----
    if hybrid and _bm25 is None:
        _restore_bm25_from_chroma()
    if hybrid and _bm25 is not None:
        _set_bm25_params(bm25_k1, bm25_b)
        jieba = _jieba()
        qtokens = list(jieba.cut(req.query))
        scores = _bm25.get_scores(qtokens)
        # 按分数排序，取前 fused_n；应用 file_ids / effective_version_ids 过滤
        ranked = sorted(enumerate(scores), key=lambda x: -x[1])
        for idx, sc in ranked[:fused_n]:
            d = _bm25_docs[idx]
            if req.file_ids is not None and d.get("file_id") not in req.file_ids:
                continue
            if req.effective_version_ids is not None and d.get("version_id") not in req.effective_version_ids:
                continue
            bm25_top20.append({"id": d["id"], "score": float(sc), "content": d["content"], "metadata": {}})

    # ---- RRF 融合（k=rrf_k） ----
    def rrf(rank_list):
        out = {}
        for rank, item in enumerate(rank_list):
            cid = item["id"]
            out[cid] = out.get(cid, 0.0) + 1.0 / (rrf_k + rank + 1)
        return out

    rrf_scores = rrf(vector_top20)
    if hybrid:
        for cid, s in rrf(bm25_top20).items():
            rrf_scores[cid] = rrf_scores.get(cid, 0.0) + s

    # 合并 metadata/content
    by_id = {}
    for it in vector_top20 + bm25_top20:
        by_id.setdefault(it["id"], it)
    fused = sorted(rrf_scores.items(), key=lambda x: -x[1])[:fused_n]
    fused_list = []
    for cid, s in fused:
        it = by_id.get(cid, {"id": cid, "content": "", "metadata": {}})
        fused_list.append({**it, "fused_score": s})

    results = fused_list

    # ---- rerank 精排（bge-reranker） ----
    reranked = None
    if rerank and fused_list:
        reranker = _reranker()
        pairs = [(req.query, it["content"]) for it in fused_list[:fused_n]]
        rs = reranker.predict(pairs, batch_size=8)
        # 按 rerank 分数降序取 Top-K
        order = sorted(range(len(fused_list[:fused_n])), key=lambda i: -float(rs[i]))
        results = [{**fused_list[i], "rerank_score": float(rs[i])} for i in order[:k]]
        reranked = [{"id": fused_list[i]["id"], "rerank_score": float(rs[i])} for i in order[:k]]

    # ---- 适用范围软排序（2026-08-12）：rerank 后、去重前，按 line_id 加权 ----
    # rerank 会对所有候选重打分，加权必须作用在 rerank 之后否则被覆盖；不适用=降优先级不删除（与可见范围硬过滤区分）
    def apply_boost(it):
        meta = it.get("metadata", {}) or {}
        lid = meta.get("line_id")
        base = float(it.get("rerank_score", it.get("fused_score", 0.0)))
        if lid in applicable_set:
            base *= (1 + boost)
        elif lid in inapplicable_set:
            base *= (1 - penalty)
        # 语言软排序（2026-08-13）：提问语言匹配的切片加权，不匹配降权（mixed 视为两者都匹配）
        clang = meta.get("language", "zh")
        if lang == 'en':
            if clang in ('en', 'mixed'):
                base *= (1 + lang_boost)
            elif clang == 'zh':
                base *= (1 - lang_penalty)
        elif lang == 'zh':
            if clang in ('zh', 'mixed'):
                base *= (1 + lang_boost)
            elif clang == 'en':
                base *= (1 - lang_penalty)
        return {**it, "score": base}
    results = [apply_boost(x) for x in results]

    # 去重：同 line_id 同 section_path 只留 score 最高（PRD §4.4.2）
    seen = set()
    deduped = []
    for it in results:
        meta = it.get("metadata", {}) or {}
        key = (meta.get("line_id"), meta.get("section_path"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append({
            "content": it["content"],
            "source": meta.get("source", ""),
            "section": meta.get("section_path", ""),
            "anchor": meta.get("anchor", ""),
            "has_table": bool(meta.get("has_table", False)),
            "score": it["score"],
            "id": it["id"],
            "line_id": meta.get("line_id", ""),
            "language": meta.get("language", ""),
        })
        if len(deduped) >= k:
            break

    return {
        "results": deduped,
        "bm25_top20": [{"id": x["id"], "score": x["score"]} for x in bm25_top20],
        "vector_top20": [{"id": x["id"], "score": x["score"]} for x in vector_top20],
        "fused_top20": [{"id": x["id"], "score": x["fused_score"]} for x in fused_list],
        "reranked": reranked,
    }


# ---- /rerank ----（独立端点，供 Node 单独精排）
@router.post("/rerank")
def rerank(req: RerankReq):
    if not req.candidates:
        return {"ranked": []}
    reranker = _reranker()
    pairs = [(req.query, c["content"]) for c in req.candidates]
    rs = reranker.predict(pairs, batch_size=8)
    ranked = sorted(enumerate(req.candidates), key=lambda x: -float(rs[x[0]]))
    return {"ranked": [{"id": c["id"], "score": float(rs[ranked[i][0]])} for i, (_, c) in enumerate(ranked)]}


# ---- /health ----
@router.get("/health")
def health():
    return {
        "status": "ok",
        "ready": ["convert", "search"],
        "hybrid": HYBRID,
        "rerank": RERANK,
        "top_k": TOP_K,
        "chroma_path": CHROMA_PATH,
        "embed_model_loaded": _embed_model is not None,
        "reranker_loaded": _reranker_model is not None,
        "embed_model_path_ok": os.path.isdir(EMBED_MODEL_PATH) and os.path.exists(os.path.join(EMBED_MODEL_PATH, "config.json")),
        "reranker_path_ok": os.path.isdir(RERANKER_MODEL_PATH) and os.path.exists(os.path.join(RERANKER_MODEL_PATH, "config.json")),
        "bm25_docs": len(_bm25_docs),
    }