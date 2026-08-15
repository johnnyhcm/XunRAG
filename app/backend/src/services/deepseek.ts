// LLM 直接 API 调用（S7 ⑤ 模型接入，2026-08-09 起从 llm_config 读配置）
// - OpenAI 兼容协议（deepseek/openai/custom）：POST {base}/chat/completions，Bearer 鉴权，SSE data: 行
// - Anthropic 原生协议：POST {base}/v1/messages，x-api-key + anthropic-version，SSE event:/data: 行
// 高效模式用流式（streamDeepseek，reasoning_effort:'none' 关推理——2026-08-06 定案）；
// 意图识别用非流式 JSON（completeJSON，temperature:0 + response_format json_object）
import { getLLMConfig, type LLMConfig } from './model-config.js';
import { getNumber, getBool } from './config.js';
import { runWithLocalQueue } from './llm-queue.js';
import { LOCAL_LLM_BASE } from './local-llm.js';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }

export interface DeepseekStreamCallbacks {
  onDelta: (text: string) => void;
  onDone?: (usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => void;
  onError?: (e: Error) => void;
  onFirstToken?: () => void;
}

function normBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/** 读取生效 LLM 配置并校验 key/model（缺任一抛错，消息友好）；本地模式=本地地址+无鉴权 */
function requireLLM(): LLMConfig & { apiKey: string; model: string } {
  const cfg = getLLMConfig();
  if (cfg.mode === 'local') {
    // 2026-08-09 本地模式：llama.cpp OpenAI 兼容地址、无鉴权、模型名由 llama-server 接受（忽略）
    return {
      provider: 'openai' as const, baseUrl: `${LOCAL_LLM_BASE}/v1`, apiKey: '',
      model: cfg.model ?? 'local', source: 'db' as const, mode: 'local' as const,
    } as LLMConfig & { apiKey: string; model: string };
  }
  if (!cfg.apiKey) throw new Error('模型未配置：请在 系统配置 > 模型接入 中填写 API Key');
  if (!cfg.model) throw new Error('模型未配置：请在 系统配置 > 模型接入 中选择模型');
  return cfg as LLMConfig & { apiKey: string; model: string };
}

/** 鉴权头（openai 兼容 Bearer / anthropic x-api-key；本地模式无鉴权不带头） */
function authHeaders(provider: string, apiKey: string): Record<string, string> {
  if (!apiKey) return { 'content-type': 'application/json' }; // 2026-08-09 本地模式
  if (provider === 'anthropic') return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  return { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
}

/** system 消息从 messages 抽出（Anthropic 协议 system 是独立顶层字段） */
function splitSystem(messages: ChatMessage[]): { system: string; messages: ChatMessage[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  return { system, messages: messages.filter((m) => m.role !== 'system') };
}

/** 调用 LLM 流式生成，回调 chunks。返回 { usage, abort }（OpenAI 兼容 + Anthropic 双协议） */
export async function streamDeepseek(
  messages: ChatMessage[],
  cb: DeepseekStreamCallbacks,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  const { provider, baseUrl, apiKey, model, mode } = requireLLM();
  // 2026-08-09 本地模式：2 并发 + 排队超时（llm-queue）
  if (mode === 'local') {
    return runWithLocalQueue(() => doStream(messages, cb, { ...opts, provider, baseUrl, apiKey, model, local: true }));
  }
  return doStream(messages, cb, { ...opts, provider, baseUrl, apiKey, model, local: false });
}

async function doStream(
  messages: ChatMessage[],
  cb: DeepseekStreamCallbacks,
  cfg: { provider: string; baseUrl: string; apiKey: string; model: string; signal?: AbortSignal; local: boolean },
): Promise<void> {
  const { provider, baseUrl, apiKey, model, local } = cfg;
  const ctrl = new AbortController();
  if (cfg.signal) cfg.signal.addEventListener('abort', () => ctrl.abort());
  const t = setTimeout(() => ctrl.abort(), getNumber('efficient.generate.timeout_ms', 60_000));
  let firstToken = false;
  let usage: any = null;
  try {
    const base = normBase(baseUrl);
    const url = provider === 'anthropic' ? `${base}/v1/messages` : `${base}/chat/completions`;
    const isAnthropic = provider === 'anthropic';
    const { system, messages: bodyMsgs } = splitSystem(messages);
    const body: any = isAnthropic
      ? {
          model,
          max_tokens: 4096,
          system: system || undefined,
          messages: bodyMsgs,
          stream: true,
        }
      : {
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          // 2026-08-13 模型推理开关（efficient.reasoning，默认关）：高效模式定位"快而稳"，关推理降耗时；
          // 云端 OpenAI 兼容：关=reasoning_effort:'none'（显式关），开=不传（模型默认思考，显式开启见 deepseek reasoning_effort）
          // 本地 llama.cpp：per-request chat_template_kwargs.enable_thinking（llama.cpp v10333 spike 验证双向可控）
          ...(local
            ? { chat_template_kwargs: { enable_thinking: getBool('efficient.reasoning', false) } }
            : getBool('efficient.reasoning', false) ? {} : { reasoning_effort: 'none' }),
        };
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(provider, apiKey),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const txt = await res.text().catch(() => '');
      throw new Error(`${provider} ${res.status} ${url}: ${txt.slice(0, 160)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        if (isAnthropic) {
          // Anthropic SSE：event: xxx / data: {...} 两行一组
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { cb.onDone?.(usage); return; }
          try {
            const obj = JSON.parse(data);
            if (obj.type === 'message_start' && obj.message?.usage) usage = { ...(usage ?? {}), ...obj.message.usage };
            if (obj.type === 'message_delta' && obj.usage) usage = { ...(usage ?? {}), ...obj.usage };
            const delta = obj.delta?.text;
            if (delta) {
              if (!firstToken) { firstToken = true; cb.onFirstToken?.(); }
              cb.onDelta(delta);
            }
          } catch { /* skip */ }
        } else {
          // OpenAI 兼容 SSE：data: 行
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { cb.onDone?.(usage); return; }
          try {
            const obj = JSON.parse(data);
            if (obj.usage) usage = obj.usage;
            const delta = obj.choices?.[0]?.delta?.content;
            if (delta) {
              if (!firstToken) { firstToken = true; cb.onFirstToken?.(); }
              cb.onDelta(delta);
            }
          } catch { /* skip */ }
        }
      }
    }
    cb.onDone?.(usage);
  } catch (e: any) {
    cb.onError?.(e);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** 非流式调用（意图识别等 JSON 输出场景）。返回 { text, usage }；Anthropic 的 usage 映射为 prompt/completion tokens */
export async function completeJSON(
  messages: ChatMessage[],
  opts: { temperature?: number; timeoutMs?: number } = {},
): Promise<{ text: string; usage: { prompt_tokens?: number; completion_tokens?: number } | null }> {
  const { provider, baseUrl, apiKey, model, mode } = requireLLM();
  // 2026-08-09 本地模式：排队 + 不传 response_format（llama-server 兼容性；prompt 已约束 JSON 输出）
  if (mode === 'local') {
    return runWithLocalQueue(() => doCompleteJSON(messages, { ...opts, provider, baseUrl, apiKey, model, local: true }));
  }
  return doCompleteJSON(messages, { ...opts, provider, baseUrl, apiKey, model, local: false });
}

async function doCompleteJSON(
  messages: ChatMessage[],
  opts: { temperature?: number; timeoutMs?: number; provider: string; baseUrl: string; apiKey: string; model: string; local: boolean },
): Promise<{ text: string; usage: { prompt_tokens?: number; completion_tokens?: number } | null }> {
  const { provider, baseUrl, apiKey, model, local } = opts;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? getNumber('efficient.intent.timeout_ms', 20_000));
  try {
    const base = normBase(baseUrl);
    const isAnthropic = provider === 'anthropic';
    const { system, messages: bodyMsgs } = splitSystem(messages);
    const body: any = isAnthropic
      ? { model, max_tokens: 4096, system: system || undefined, messages: bodyMsgs, temperature: opts.temperature ?? 0 }
      : { model, messages, temperature: opts.temperature ?? 0, ...(local ? {} : { response_format: { type: 'json_object' } }), reasoning_effort: 'none' };
    const url = isAnthropic ? `${base}/v1/messages` : `${base}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(provider, apiKey),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${provider} ${res.status}`);
    const data = await res.json() as any;
    const text = isAnthropic
      ? (data?.content ?? []).map((c: any) => c?.text ?? '').join('')
      : (data?.choices?.[0]?.message?.content ?? '');
    const usage = isAnthropic
      ? data?.usage ? { prompt_tokens: data.usage.input_tokens, completion_tokens: data.usage.output_tokens } : null
      : data?.usage ? { prompt_tokens: data.usage.prompt_tokens, completion_tokens: data.usage.completion_tokens } : null;
    return { text, usage };
  } finally {
    clearTimeout(t);
  }
}

export function deepseekAbortError(e: unknown): e is Error {
  return e instanceof Error && (e.name === 'AbortError' || /aborted/i.test(e.message));
}
