// 本地模型 API（2026-08-09，S7 ⑤ 本地模式）—— config_mgmt 权限
// GET  /api/local-model/models        扫描 models/llm/ 已下载模型
// GET  /api/local-model/status        引擎运行状态 + 健康
// POST /api/local-model/start         启动 llama-server（系统托管）
// POST /api/local-model/stop          停止
// POST /api/local-model/test          启动（如未运行）+ 最小对话验证
import { Router } from 'express';
import { requireFn } from '../services/permission.js';
import {
  scanLocalModels, startLocalLLM, stopLocalLLM, localHealth, testLocalModel, isLocalConfigured, detectGpuMemory,
} from '../services/local-llm.js';

export const localModelRouter = Router();
// 2026-08-12 修复：删除全局 config_mgmt 中间件（挂在根路径会拦截所有 /api/* 请求，曾致 /api/security/levels 等端点 403）——改每个 local-model 路由单独挂 requireFn

// 扫描已下载模型
localModelRouter.get('/local-model/models', requireFn('config_mgmt'), (_req, res) => {
  res.json({ models: scanLocalModels() });
});

// 引擎状态（运行中 + 健康 + 是否已配置模型 + 显存）
localModelRouter.get('/local-model/status', requireFn('config_mgmt'), async (_req, res) => {
  const health = await localHealth();
  const gpu = await detectGpuMemory(); // 2026-08-10：真实显存（无 nvidia-smi → null 降级）
  res.json({ running: health.running, loaded: health.loaded, error: health.error, configured: isLocalConfigured(), gpu });
});

// 启动
localModelRouter.post('/local-model/start', requireFn('config_mgmt'), (_req, res) => {
  const r = startLocalLLM();
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true });
});

// 停止
localModelRouter.post('/local-model/stop', requireFn('config_mgmt'), (_req, res) => {
  stopLocalLLM();
  res.json({ ok: true });
});

// 测试连接（可带 model_file 先选择模型）
localModelRouter.post('/local-model/test', requireFn('config_mgmt'), async (req, res) => {
  const modelFile = typeof req.body?.model_file === 'string' && req.body.model_file ? String(req.body.model_file) : undefined;
  const r = await testLocalModel(modelFile ? { model_file: modelFile } : undefined);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, latency_ms: r.latency_ms });
});
