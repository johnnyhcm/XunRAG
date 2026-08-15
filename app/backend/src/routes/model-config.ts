// 模型接入 API（S7 ⑤，PRD §4.4.9 / TECH.md §3.8）
// GET  /api/model-config           公开只读：界面配置（key 只回掩码 + 是否已配置）——与 /api/configs 同权限策略
// PUT  /api/model-config           需 config_mgmt：保存（key 传新值加密更新，不传保留原值，clear_key 显式清空）
// POST /api/model-config/test      需 config_mgmt：用表单值真实拨号测试连接（key 未传则用已保存）
// GET  /api/model-config/models    需 config_mgmt：用已保存配置拉模型列表（下拉数据源）
import { Router } from 'express';
import { getLLMConfig, getPublicLLMConfig, saveLLMConfig, listModels, testConnection, type ProviderId } from '../services/model-config.js';
import { startLocalLLM, stopLocalLLM } from '../services/local-llm.js';
import { requireFn } from '../services/permission.js';
import { invalidateSmartRuntime } from '../services/smartChat.js';
import { E, sendErr } from '../services/errors.js';

export const modelConfigRouter = Router();

// GET /api/model-config —— 界面配置（key 只回掩码）
modelConfigRouter.get('/model-config', (_req, res) => {
  res.json(getPublicLLMConfig());
});

// PUT /api/model-config —— 保存
modelConfigRouter.put('/model-config', requireFn('config_mgmt'), (req, res) => {
  const prev = getLLMConfig(); // 保存前状态（判断是否真正切换了模式）
  saveLLMConfig(req.body ?? {}, req.sessionId ?? null);
  // 2026-08-10：模式联动引擎启停——切云端停本地引擎（释放显存）；切本地拉起引擎（后台加载，不阻塞响应）
  const newMode = req.body?.mode;
  if (newMode === 'cloud' && prev.mode === 'local') {
    stopLocalLLM();
    console.log('[local-llm] 已切换到云端模式，停止本地引擎（释放显存）');
  } else if (newMode === 'local' && prev.mode !== 'local') {
    const r = startLocalLLM();
    if (!r.ok) console.warn(`[local-llm] 切换到本地模式但引擎未启动：${r.error ?? ''}`);
    else console.log('[local-llm] 已切换到本地模式，后台拉起引擎（模型加载约 30-60s）');
  }
  invalidateSmartRuntime(); // Pi SDK runtime 重建（下次请求生效）
  res.json({ ok: true });
});

// POST /api/model-config/test —— 测试连接（真实拨号）
modelConfigRouter.post('/model-config/test', requireFn('config_mgmt'), async (req, res) => {
  const body = req.body ?? {};
  const saved = getLLMConfig();
  // 表单值优先，未提供则用已保存值（测试未改动的字段）
  const provider = (body.provider as ProviderId) || saved.provider;
  const baseUrl = (body.base_url as string) || saved.baseUrl;
  const apiKey = (body.api_key as string) || saved.apiKey;
  if (!apiKey) return sendErr(req, res, 400, E('MODEL_NO_API_KEY', '未配置 API Key', 'API key not configured'));
  // 2026-08-09：服务商已变更但未填新 key → 拒绝用旧 key 测试（避免误连旧服务商）
  if (!(body.api_key as string) && body.provider && body.provider !== saved.provider) {
    return sendErr(req, res, 400, E('MODEL_PROVIDER_KEY_MISMATCH', '服务商已变更：旧 API Key 不可复用，请填写新服务商的 Key', 'Provider changed: the old API key cannot be reused; please enter the new provider key'));
  }
  const result = await testConnection({ provider, baseUrl, apiKey });
  if (result.ok) res.json(result);
  else sendErr(req, res, 400, E('MODEL_CONNECT_FAILED', '连接失败', 'Connection failed'));
});

// GET /api/model-config/models —— 用已保存配置拉模型列表
modelConfigRouter.get('/model-config/models', requireFn('config_mgmt'), async (req, res) => {
  const cfg = getLLMConfig();
  if (!cfg.apiKey) return sendErr(req, res, 400, E('MODEL_NO_API_KEY_FORM', '未配置 API Key：请先在表单填写并测试连接', 'API key not configured: fill it in the form and test the connection first'));
  try {
    const models = await listModels({ provider: cfg.provider, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
    res.json({ models });
  } catch (e: any) {
    // Anthropic 兼容实现（DeepSeek /anthropic 等）无 /models 接口：不阻塞，提示手动输入
    if (cfg.provider === 'anthropic') {
      res.json({ models: [], note: '该服务未提供模型列表接口，可手动输入模型名' });
    } else {
      res.status(400).json({ error: e?.message ?? String(e) });
    }
  }
});
