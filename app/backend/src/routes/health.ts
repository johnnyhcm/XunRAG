// 健康检查路由
import { Router } from 'express';
import type { HealthResponse } from '@policybot/shared';
import { config } from '../config.js';
import { getLLMConfig } from '../services/model-config.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  // 探测 Python /convert 服务（S2 起 Python 已启动）
  let python: 'up' | 'down' = 'down';
  try {
    const t = new AbortController();
    const to = setTimeout(() => t.abort(), 1500);
    const r = await fetch(`${config.pythonBaseUrl}/health`, { signal: t.signal });
    clearTimeout(to);
    if (r.ok) python = 'up';
  } catch { /* down */ }
  const body: HealthResponse = {
    status: 'ok',
    backend: 'up',
    deepseek: getLLMConfig().apiKey ? 'connected' : 'unconfigured',
    python,
  };
  res.json(body);
});