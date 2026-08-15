// 本地模型引擎托管（2026-08-09，PRD §4.4.9 ⑤ 本地模式 / TECH 实现设计）
// - 系统托管 llama-server 子进程：启动/停止/重启、崩溃自动重启（退避）、健康检查、日志
// - 启动参数模板：--model <gguf> -c <ctx> -ctk q8_0（kv 量化开时）--n-gpu-layers <N> --reasoning <on|off> --host 127.0.0.1 --port <port>
// - WDDM 注意：llama.cpp 无法自动查询显存（failed to fit params）→ gpu_layers 必须显式指定（默认 40，8GB 实测可跑）
// - 思考模式必须显式 --reasoning off（Qwen3.5 默认 auto 输出 reasoning_content、content 空）
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { getConfig } from './config.js';

export const LOCAL_LLM_PORT = 8080;
export const LOCAL_LLM_BASE = `http://127.0.0.1:${LOCAL_LLM_PORT}`;

let proc: ChildProcess | null = null;
let restartCount = 0;
let lastRestartAt = 0;

/** 本地引擎可执行文件（部署包内置 tools/llama.cpp/；可用 env LLAMA_SERVER 覆盖） */
export function llamaServerPath(): string {
  const env = process.env.LLAMA_SERVER;
  if (env && fs.existsSync(env)) return env;
  const bundled = path.join(config.root, 'tools', 'llama.cpp', 'llama-server.exe');
  if (fs.existsSync(bundled)) return bundled;
  return 'llama-server'; // 回退 PATH（系统已安装时）
}

/** 读取本地配置（llm_config）+ 智能推理开关（smart.reasoning，2026-08-13 起引擎思考由问答配置派生，llm_config.thinking 列废弃） */
function localCfg(): { model_file: string; ctx_size: number; kv_quantize: number; gpu_layers: number; thinking: number; port: number } {
  const row = getDb().prepare('SELECT model_file, ctx_size, kv_quantize, gpu_layers FROM llm_config WHERE id=1').get() as any;
  return {
    model_file: row?.model_file ?? '',
    ctx_size: Number(row?.ctx_size ?? 16384),
    kv_quantize: Number(row?.kv_quantize ?? 1),
    gpu_layers: Number(row?.gpu_layers ?? 40),
    // 2026-08-13：智能模式推理开关（默认开）→ 引擎 --reasoning on/off；高效模式思考由请求级 chat_template_kwargs 独立控制（deepseek.ts）
    thinking: getConfig('smart.reasoning', '1') === '1' ? 1 : 0,
    port: LOCAL_LLM_PORT,
  };
}

/** 构建 llama-server 启动参数（导出供测试：本地引擎思考派生验证） */
export function buildArgs(cfg: ReturnType<typeof localCfg>): string[] {
  const args = [
    '--model', cfg.model_file,
    '-c', String(cfg.ctx_size),
    '--host', '127.0.0.1',
    '--port', String(cfg.port),
  ];
  if (cfg.kv_quantize) args.push('-ctk', 'q8_0'); // KV 量化省显存（大显存可关）
  args.push('--n-gpu-layers', String(cfg.gpu_layers)); // WDDM 下必须显式（不能靠 fit）
  args.push('--reasoning', cfg.thinking ? 'on' : 'off'); // 思考模式（默认关；Qwen3.5 默认 auto 会输出 reasoning_content）
  return args;
}

/** 本地引擎是否配置了模型 */
export function isLocalConfigured(): boolean {
  const cfg = localCfg();
  return Boolean(cfg.model_file) && fs.existsSync(cfg.model_file);
}

/** 启动 llama-server（模型未配置/文件不存在 → 抛错） */
export function startLocalLLM(): { ok: boolean; error?: string } {
  if (proc && proc.exitCode === null) return { ok: true, error: '已在运行' };
  const cfg = localCfg();
  if (!cfg.model_file) return { ok: false, error: '未选择本地模型（请在 系统配置 > 模型接入 > 本地模式 选择）' };
  if (!fs.existsSync(cfg.model_file)) return { ok: false, error: `模型文件不存在：${cfg.model_file}` };
  const bin = llamaServerPath();
  if (!fs.existsSync(bin) && bin === 'llama-server') return { ok: false, error: '未找到 llama-server（部署包内置或设置 LLAMA_SERVER 环境变量）' };
  const args = buildArgs(cfg);
  const logFile = path.join(config.root, 'data', 'logs', 'llm.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  proc = spawn(bin, args, { stdio: ['ignore', out, out], windowsHide: true });
  proc.on('exit', (code) => {
    // 崩溃自动重启（退避：60s 内最多 3 次；正常 stop 不重启）
    if (proc && code !== 0 && Date.now() - lastRestartAt > 60_000) {
      restartCount = 0;
      lastRestartAt = Date.now();
      console.error(`[local-llm] llama-server 异常退出（code=${code}），60s 内第 ${restartCount + 1} 次重启`);
      if (restartCount < 3) { restartCount++; setTimeout(() => startLocalLLM(), 3000); }
    } else if (proc) {
      restartCount = 0;
    }
    proc = null;
  });
  return { ok: true };
}

/** 停止 llama-server */
export function stopLocalLLM(): void {
  if (proc && proc.exitCode === null) { proc.kill(); proc = null; }
}

/** 本地引擎是否运行中 */
export function isLocalRunning(): boolean {
  return Boolean(proc && proc.exitCode === null);
}

/** 显存检测（nvidia-smi，Windows NVIDIA 卡；2026-08-10）
 *  llama.cpp 自身无法查询显存（WDDM failed to fit params），但系统层 nvidia-smi 可拿；
 *  无 nvidia-smi / 非 NVIDIA / 超时 → null（界面降级不显示，只显示模型文件大小与配置参数） */
export async function detectGpuMemory(): Promise<{ total_mb: number; used_mb: number; free_mb: number } | null> {
  try {
    const { execFile } = await import('node:child_process');
    const out = await new Promise<string>((resolve, reject) => {
      execFile('nvidia-smi', ['--query-gpu=memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'],
        { timeout: 3000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    });
    const parts = out.trim().split(',').map((s) => Number(s.trim()));
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
    const [total_mb, used_mb, free_mb] = parts;
    return { total_mb, used_mb, free_mb };
  } catch { return null; }
}

/** 健康检查：进程活着 + 探测 /v1/models（不依赖进程状态判断，真实探测） */
export async function localHealth(): Promise<{ running: boolean; loaded: boolean; error?: string }> {
  if (!isLocalRunning()) return { running: false, loaded: false };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${LOCAL_LLM_BASE}/v1/models`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) return { running: true, loaded: true };
    return { running: true, loaded: false, error: `HTTP ${res.status}` };
  } catch {
    return { running: true, loaded: false, error: '探测失败（服务可能仍在启动）' };
  }
}

/** 扫描 models/llm/ 目录，列出已下载模型（GGUF + 大小 + 元数据） */
export function scanLocalModels(): { name: string; file: string; size_mb: number; has_meta: boolean }[] {
  const dir = path.join(config.root, 'models', 'llm');
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const sub = path.join(dir, d.name);
        const gguf = fs.readdirSync(sub).find((f) => f.toLowerCase().endsWith('.gguf'));
        if (!gguf) return null;
        const file = path.join(sub, gguf);
        const size = fs.statSync(file).size;
        return {
          name: d.name,
          file: file.replace(/\\/g, '/'),
          size_mb: Math.round(size / 1024 / 1024),
          has_meta: fs.existsSync(path.join(sub, 'model.yaml')) || fs.existsSync(path.join(sub, 'manifest.json')),
        };
      })
      .filter(Boolean) as { name: string; file: string; size_mb: number; has_meta: boolean }[];
  } catch { return []; }
}

/** 测试连接：启动（若未运行）+ 最小对话验证 */
export async function testLocalModel(cfg?: { model_file: string }): Promise<{ ok: boolean; error?: string; latency_ms?: number; gpu?: string }> {
  if (cfg?.model_file) {
    const db = getDb();
    db.prepare("UPDATE llm_config SET model_file=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=1").run(cfg.model_file);
  }
  const started = startLocalLLM();
  if (!started.ok) return { ok: false, error: started.error };
  // 等待服务就绪（最长 120s，9B Q4 加载约 30-60s）
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const h = await localHealth();
    if (h.loaded) break;
    if (Date.now() > deadline) return { ok: false, error: `模型加载超时（${h.error ?? '未知'}）` };
    await new Promise((r) => setTimeout(r, 2000));
  }
  // 最小对话
  try {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60_000);
    const res = await fetch(`${LOCAL_LLM_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'local', messages: [{ role: 'user', content: '你好' }], max_tokens: 10 }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const data = await res.json() as any;
    const content = data?.choices?.[0]?.message?.content ?? '';
    if (!content) return { ok: false, error: '模型无输出（可能思考模式未正确关闭）' };
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, error: `对话测试失败：${e?.message ?? e}` };
  }
}
