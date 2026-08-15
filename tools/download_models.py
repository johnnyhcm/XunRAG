#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""XunRAG 模型下载脚本 —— 下载检索所需模型到 models/（开源部署必需）

下载内容：
  - bge-m3            向量模型      -> models/embedding/bge-m3/
  - bge-reranker-v2-m3 精排模型     -> models/reranker/bge-reranker-v2-m3/

用法：
  python tools/download_models.py            # ModelScope 下载（默认，国内快）
  python tools/download_models.py --source huggingface   # HuggingFace 下载

说明：
  - 已存在目标目录则跳过（幂等，可重复执行）
  - 本地 LLM（可选）不在此脚本内：自行下载 GGUF 文件放到 models/llm/<名称>/
"""
import argparse
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

MODELS = [
    # (model_id, local_dir)
    ("BAAI/bge-m3", os.path.join("models", "embedding", "bge-m3")),
    ("BAAI/bge-reranker-v2-m3", os.path.join("models", "reranker", "bge-reranker-v2-m3")),
]


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def already_downloaded(local_dir: str) -> bool:
    """目录存在且非空（含 config.json 即视为已下载）"""
    config = os.path.join(local_dir, "config.json")
    return os.path.exists(config) and os.path.getsize(config) > 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Download XunRAG models")
    parser.add_argument("--source", choices=["modelscope", "huggingface"], default="modelscope")
    args = parser.parse_args()

    for model_id, rel_dir in MODELS:
        local_dir = os.path.join(ROOT, rel_dir)
        if already_downloaded(local_dir):
            print(f"[skip] {model_id} 已存在（{rel_dir}）")
            continue
        ensure_dir(local_dir)
        print(f"[download] {model_id} -> {rel_dir}（{args.source}）...")
        try:
            if args.source == "huggingface":
                from huggingface_hub import snapshot_download
                snapshot_download(repo_id=model_id, local_dir=local_dir)
            else:
                from modelscope import snapshot_download
                snapshot_download(model_id=model_id, local_dir=local_dir)
        except ImportError as e:
            print(f"[error] 缺少依赖：{e}。请先安装：pip install {'huggingface_hub' if args.source == 'huggingface' else 'modelscope'}")
            return 1
        except Exception as e:
            print(f"[error] 下载失败 {model_id}：{e}")
            return 1
        print(f"[ok] {model_id} 下载完成")
    print("\n模型下载完成。可选：本地 LLM（GGUF）放入 models/llm/<名称>/ 后，在「模型接入」页面配置。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
