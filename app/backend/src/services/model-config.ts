// 模型接入配置服务（S7 ⑤，PRD §4.4.9 / TECH.md §3.8）
// - 预设 provider：openai / anthropic / deepseek / custom（OpenAI 兼容）
// - 读取链：llm_config 表（界面配置，key 解密）→ env（DEEPSEEK_API_KEY/DEEPSEEK_MODEL）→ 旧 key 文件（deepseek.key）
// - 每次调用直读 DB（微秒级，与 ConfigService 同哲学：配置低频变化，实时生效）
import { getDb } from '../db/index.js';
import { decryptSecret, maskSecret, readApiKeyFile, writeApiKeyFile, clearApiKeyFile, hasMasterKey, listApiKeyStatus } from './secrets.js';
import { config } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** provider 预设（baseUrl 默认值；Pi SDK provider id 映射；鉴权协议） */
export const PROVIDERS = {
  openai:   { label: 'OpenAI',   baseUrl: 'https://api.openai.com/v1',    sdkProvider: 'openai',   protocol: 'openai' },
  anthropic:{ label: 'Anthropic',baseUrl: 'https://api.anthropic.com',    sdkProvider: 'anthropic',protocol: 'anthropic' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com',     sdkProvider: 'deepseek', protocol: 'openai' },
  custom:   { label: '自定义 (OpenAI 兼容)', baseUrl: '',                 sdkProvider: 'custom',   protocol: 'openai' },
} as const;
export type ProviderId = keyof typeof PROVIDERS;

export interface LLMConfig {
  provider: ProviderId;
  baseUrl: string;          // 实际使用的 baseUrl（预设默认或自定义）
  apiKey: string | null;
  model: string | null;
  /** 配置来源：db=界面配置 / env=环境变量兑底 / file=key 文件兑底 / none */
  source: 'db' | 'env' | 'file' | 'none';
  /** 2026-08-09：接入模式 cloud=云端 API / local=本地模型 */
  mode: 'cloud' | 'local';
}

function loadLegacyKeyFile(): string | null {
  const keyFile = path.join(os.homedir(), '.policybot-secrets', 'deepseek.key');
  try {
    if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim() || null;
  } catch { /* ignore */ }
  return null;
}

/** 有效 provider（容错非法值回退 deepseek） */
function validProvider(p: string | null | undefined): ProviderId {
  return p && p in PROVIDERS ? (p as ProviderId) : 'deepseek';
}

/** 读取当前生效的 LLM 配置（含 env / 旧 key 文件兑底） */
export function getLLMConfig(): LLMConfig {
  const db = getDb();
  const row = db.prepare('SELECT provider, base_url, model, api_key_enc, mode FROM llm_config WHERE id=1').get() as
    { provider: string; base_url: string | null; model: string | null; api_key_enc: string | null; mode: string } | undefined;

  if (row) {
    // 界面配置过（有行）：一律以界面为准——key 空 = 明确未配置，**不回退** env/文件
    // （否则管理员清空 key 后静默回退旧 key，配置与行为不一致；2026-08-09 修复）
    const provider = validProvider(row.provider);
    // 2026-08-09 B3：API key 从加密文件 llm.key.<provider>.enc 读（不再解密 DB 密文）
    migrateLegacyDbKey(row); // 存量迁移：旧 DB 密文 → 加密文件（若文件已有则跳过）
    return {
      provider,
      baseUrl: row.base_url || PROVIDERS[provider].baseUrl,
      apiKey: readApiKeyFile(provider),
      model: row.model,
      source: 'db',
      mode: row.mode === 'local' ? 'local' as const : 'cloud' as const,
    };
  }

  // 无界面配置 → env 兑底（运维最高优先级，兼容旧配置；模型默认 deepseek-v4-flash——2026-08-06 定案）
  const envKey = process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || null;
  if (envKey) {
    return {
      provider: 'deepseek',
      baseUrl: PROVIDERS.deepseek.baseUrl,
      apiKey: envKey,
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      source: 'env',
      mode: 'cloud',
    };
  }

  // 旧 key 文件兑底（S0 验证期 key，平滑迁移；模型默认 deepseek-v4-flash）
  const fileKey = loadLegacyKeyFile();
  if (fileKey) {
    return {
      provider: 'deepseek',
      baseUrl: PROVIDERS.deepseek.baseUrl,
      apiKey: fileKey,
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      source: 'file',
      mode: 'cloud',
    };
  }

  return { provider: 'deepseek', baseUrl: PROVIDERS.deepseek.baseUrl, apiKey: null, model: null, source: 'none', mode: 'cloud' };
}

/** 界面可见的配置（key 只回掩码 + 是否已配置）——GET /api/model-config */
export function getPublicLLMConfig() {
  const db = getDb();
  const row = db.prepare('SELECT provider, base_url, model, api_key_enc, mode FROM llm_config WHERE id=1').get() as
    { provider: string; base_url: string | null; model: string | null; api_key_enc: string | null; mode: string } | undefined;
  const effective = getLLMConfig();
  // 2026-08-09 本地模式：读 llm_config 本地列
  const local = db.prepare('SELECT mode, engine, model_file, ctx_size, kv_quantize, gpu_layers, thinking, concurrency, queue_timeout FROM llm_config WHERE id=1').get() as any;
  // 2026-08-10：各服务商 key 状态（换服务商时界面展示掩码，避免重填）
  const curProvider = row ? validProvider(row.provider) : 'deepseek';
  return {
    provider: curProvider,
    base_url: row?.base_url ?? null,
    model: row?.model ?? null,
    api_key_masked: maskSecret(readApiKeyFile(curProvider)),
    has_key: Boolean(readApiKeyFile(curProvider)),
    keys: listApiKeyStatus(), // { openai/anthropic/deepseek/custom: {has_key, masked} }
    master_key_configured: hasMasterKey(), // 2026-08-09 B3：加密密钥（POLICYBOT_MASTER_KEY）是否配置
    source: effective.source,
    mode: local?.mode ?? 'cloud',
    local: {
      engine: local?.engine ?? 'llama.cpp',
      model_file: local?.model_file ?? null,
      ctx_size: Number(local?.ctx_size ?? 16384),
      kv_quantize: Number(local?.kv_quantize ?? 1),
      gpu_layers: Number(local?.gpu_layers ?? 40),
      thinking: Number(local?.thinking ?? 0),
      concurrency: Number(local?.concurrency ?? 2),
      queue_timeout: Number(local?.queue_timeout ?? 60000),
    },
  };
}

/** 保存界面配置（2026-08-10 重构）
 *  - 只更新前端传了的字段（分列 UPDATE）——切模式只传 {mode} 不再重置 provider/baseUrl/model（修复原 INSERT ON CONFLICT 覆盖隐患）
 *  - API key 按服务商独立存储 llm.key.<provider>.enc：换服务商各自 key 保留，不重填；传新值才写、clear_key 才清，不再因 providerChanged 清 key */
export function saveLLMConfig(body: {
  provider?: string; base_url?: string | null; model?: string | null;
  api_key?: string; clear_key?: boolean;
  mode?: string; engine?: string; model_file?: string | null; ctx_size?: number;
  kv_quantize?: number; gpu_layers?: number; thinking?: number;
  concurrency?: number; queue_timeout?: number;
}, by: string | null): void {
  const db = getDb();
  const existing = db.prepare('SELECT provider FROM llm_config WHERE id=1').get() as { provider: string } | undefined;
  // 生效 provider：传了用传的，没传用现有的（供 key 文件读写与 provider 列更新）
  const provider = body.provider !== undefined ? validProvider(body.provider) : (existing ? validProvider(existing.provider) : 'deepseek');

  // 2026-08-09 B3 + 2026-08-10：API key 按服务商写加密文件 llm.key.<provider>.enc
  const newKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
  if (body.clear_key) clearApiKeyFile(provider);
  else if (newKey) {
    if (!writeApiKeyFile(newKey, provider)) throw new Error('加密密钥未配置（POLICYBOT_MASTER_KEY），无法保存 API Key');
  }

  // 云端列（仅传了才更新）
  const sets: string[] = []; const vals: any[] = [];
  const upd = (f: string, v: any) => { if (v !== undefined) { sets.push(`${f}=?`); vals.push(v); } };
  if (body.provider !== undefined) upd('provider', provider);
  if (body.base_url !== undefined) upd('base_url', (body.base_url === null || body.base_url === '') ? null : normBase(body.base_url));
  if (body.model !== undefined) upd('model', (body.model === null || body.model === '') ? null : body.model.trim());

  // 2026-08-09 本地模式参数（mode/engine/model_file/ctx/kv/gpu/thinking/并发）
  if (body.mode !== undefined) upd('mode', body.mode === 'local' ? 'local' : 'cloud');
  if (body.engine !== undefined) upd('engine', String(body.engine));
  if (body.model_file !== undefined) upd('model_file', body.model_file || null);
  if (body.ctx_size !== undefined) upd('ctx_size', Number(body.ctx_size));
  if (body.kv_quantize !== undefined) upd('kv_quantize', body.kv_quantize ? 1 : 0);
  if (body.gpu_layers !== undefined) upd('gpu_layers', Number(body.gpu_layers));
  if (body.thinking !== undefined) upd('thinking', body.thinking ? 1 : 0);
  if (body.concurrency !== undefined) upd('concurrency', Number(body.concurrency));
  if (body.queue_timeout !== undefined) upd('queue_timeout', Number(body.queue_timeout));
  upd('updated_by', by ?? null);

  if (!sets.length) return; // 无字段更新（如仅测试）
  const now = `strftime('%Y-%m-%dT%H:%M:%SZ','now')`;
  if (!existing) {
    // 首次：完整行插入（缺失列走表 DEFAULT；created_at/updated_at 用 SQL 表达式）
    const cols = ['id', ...sets];
    const iv = [1, ...vals];
    db.prepare(`INSERT INTO llm_config (${cols.join(',')}, created_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ${now}, ${now})`).run(...iv);
  } else {
    db.prepare(`UPDATE llm_config SET ${sets.join(',')}, updated_at=${now} WHERE id=1`).run(...vals);
  }
}


// ---------- 存量迁移（2026-08-09 B3）：旧 DB 密文 → 加密文件 ----------
// 仅当加密文件无 key 且 DB 有旧密文时执行（解密成功→写文件+清 DB；解密失败（旧 master.key 丢失）→ 提示重新配置）
let migratedChecked = false;
function migrateLegacyDbKey(row: { api_key_enc: string | null } | undefined): void {
  if (migratedChecked) return;
  migratedChecked = true;
  try {
    if (row?.api_key_enc && !readApiKeyFile('deepseek')) {
      const plain = decryptSecret(row.api_key_enc);
      if (plain) {
        writeApiKeyFile(plain, 'deepseek');
        getDb().prepare('UPDATE llm_config SET api_key_enc=NULL WHERE id=1').run();
        console.log('[secrets] 存量 DB 密文已迁移到加密文件 llm.key.enc');
      } else {
        console.warn('[secrets] 存量 DB 密文无法解密（旧加密密钥缺失），请重新在 系统配置 > 模型接入 配置 API Key');
      }
    }
  } catch { /* 迁移失败不阻塞 */ }
}

// ---------- provider HTTP 调用（模型拉取 + 测试连接） ----------

function anthropicHeaders(key: string): Record<string, string> {
  return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
}
function openaiHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

/** 归一化 baseUrl：去结尾斜杠 + 剥离误填的完整 chat/completions 端点（用户常见填法） */
function normBase(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
}

/** 拉取模型列表（OpenAI 兼容 GET {base}/models；Anthropic GET {base}/v1/models） */
export async function listModels(cfg: { provider: ProviderId; baseUrl: string; apiKey: string }): Promise<string[]> {
  const { provider, baseUrl, apiKey } = cfg;
  const base = normBase(baseUrl);
  const url = provider === 'anthropic' ? `${base}/v1/models` : `${base}/models`;
  const headers = provider === 'anthropic' ? anthropicHeaders(apiKey) : openaiHeaders(apiKey);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`${res.status} ${url}: ${txt.slice(0, 120)}`);
    }
    const data = await res.json() as any;
    const items: any[] = data?.data ?? data?.models ?? [];
    return items.map((m: any) => m.id ?? m.name).filter(Boolean) as string[];
  } finally {
    clearTimeout(t);
  }
}

/** Anthropic 协议最小对话探测（验证 key+端点连通）
 *  2026-08-09：Anthropic 兼容实现（如 DeepSeek /anthropic）常不提供 GET /v1/models 模型列表接口，
 *  拉列表会 404——连通性验证改用真实对话最小请求，列表失败降级为"手动输入模型名" */
export async function probeAnthropic(cfg: { baseUrl: string; apiKey: string; model?: string }): Promise<{ ok: boolean; error?: string }> {
  const url = `${normBase(cfg.baseUrl)}/v1/messages`;
  const body = { model: cfg.model ?? 'deepseek-chat', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { method: 'POST', headers: anthropicHeaders(cfg.apiKey), body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`${res.status} ${url}: ${txt.slice(0, 120)}`);
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(t);
  }
}

/** 测试连接：真实拨号验证 key/模型
 *  OpenAI 兼容=拉模型列表；Anthropic 协议=对话最小探测（列表缺失不阻塞，降级手动输入） */
export async function testConnection(cfg: { provider: ProviderId; baseUrl: string; apiKey: string; model?: string }): Promise<{ ok: boolean; models: string[]; error?: string; note?: string }> {
  if (cfg.provider === 'anthropic') {
    const probe = await probeAnthropic(cfg);
    if (!probe.ok) return { ok: false, models: [], error: probe.error };
    let models: string[] = [];
    try { models = await listModels(cfg); } catch { /* 兼容实现无 /models：不阻塞 */ }
    return {
      ok: true,
      models,
      note: models.length ? undefined : '连接成功；该服务未提供模型列表接口，可手动输入模型名',
    };
  }
  try {
    const models = await listModels(cfg);
    return { ok: true, models };
  } catch (e: any) {
    return { ok: false, models: [], error: e?.message ?? String(e) };
  }
}
