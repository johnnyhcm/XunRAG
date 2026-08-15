// /api/status —— LLM 连接状态 + 模型名 + 检索服务（S3 设置页用；2026-08-09 升级为读模型接入配置）
import { Router } from 'express';
import type { StatusResponse } from '@policybot/shared';
import { getLLMConfig } from '../services/model-config.js';

export const statusRouter = Router();

statusRouter.get('/status', (_req, res) => {
  const cfg = getLLMConfig();
  const body: StatusResponse = {
    deepseek: {
      // 是否已配置（界面 llm_config / env / 旧 key 文件任一来源）
      connected: Boolean(cfg.apiKey),
      model: cfg.apiKey ? (cfg.model ?? null) : null,
    },
  };
  // 附加来源与 provider（前端可展示，向后兼容）
  (body as any).llm = { provider: cfg.provider, source: cfg.source, baseUrl: cfg.baseUrl };
  res.json(body);
});