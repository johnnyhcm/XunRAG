"""Python 服务入口（FastAPI，localhost:8001）

上线节奏（TECH.md §3.3）：
  S2：仅 /convert（Word→MD + 图片提取 + 语言检测 + 封面/目录/页眉页脚标记）
  S3：补 /embed /search /rerank /health（同进程）

启动：python server.py
"""
import os
from fastapi import FastAPI
from pydantic import BaseModel

from routers import convert, retrieval

app = FastAPI(title="PolicyBot Python Service")


@app.get("/")
def root():
    return {"service": "policybot-python", "ready": ["convert", "search"]}


@app.get("/health")
def health():
    return retrieval.health()


app.include_router(convert.router)
app.include_router(retrieval.router)


def main():
    host = os.getenv("PYTHON_HOST", "127.0.0.1")
    port = int(os.getenv("PYTHON_PORT", "8001"))
    print(f"[python] service ready on http://{host}:{port} (convert)")
    import uvicorn
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()