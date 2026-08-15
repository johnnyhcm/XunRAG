// Node.js 后端入口 —— Express 业务调度层（TECH.md §1）
// 2026-08-08 全局异常兜底：未捕获异常/未处理 rejection 记日志不退出（单请求错误不再杀死整个服务——
//   此前一次异常导致进程退出、全部请求 500/挂起；S8 进程守护 NSSM 为最终方案，代码级兜底先上）
process.on('uncaughtException', (e) => { console.error('[backend] uncaughtException:', e?.stack ?? e); });
process.on('unhandledRejection', (e) => { console.error('[backend] unhandledRejection:', e); });
import express from 'express';
import https from 'node:https';
import fs from 'node:fs';
import cors from 'cors';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { getDb } from './db/index.js';
import { sessionMiddleware } from './middleware/session.js';
import { authMiddleware } from './middleware/auth.js';
import { apiRouter } from './routes/index.js';
import { syncIndexFromDb } from './services/ingest.js';
import { getMasterKey } from './services/secrets.js';
import { startLocalLLM, LOCAL_LLM_BASE } from './services/local-llm.js';
import type { AppConfig } from './config.js';

export function createServer(config: AppConfig | unknown = null){
  const app = express();
  // CORS 收紧（P0-4，2026-08-13）：默认仅允许 localhost 开发 + 环境变量白名单；前端经 vite proxy 同源访问不受影响
  const corsWhitelist = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // 非浏览器请求（curl/SSE/同源 proxy）
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true); // 开发
      if (corsWhitelist.includes(origin)) return cb(null, true); // 生产白名单
      cb(null, false); // 其他跨域拒绝
    },
    credentials: true,
  }));
  app.use(express.json({ limit: '2mb' }));
  // 先解析 session（X-Session-Id），再做认证
  app.use(sessionMiddleware);
  app.use(authMiddleware);
  app.use('/api', apiRouter);
  return app;
}

export function startServer(cfg: AppConfig = config): void {
  // 首次启动建库（用户表 19 字段，PRD §6.2.1）
  getDb();
  // 启动时加载加密密钥（POLICYBOT_MASTER_KEY）；开发模式（AUTH_MODE≠production）无 env 时自动生成 master.key 落盘（2026-08-10 方案 A），生产必须由管理员注入 env（B3 密钥分离）
  getMasterKey();
  // 2026-08-09：Pi 原生 llama.cpp provider 的 baseUrl 环境变量（本地 llama-server；Pi SDK 内置 provider 读 LLAMA_BASE_URL）
  process.env.LLAMA_BASE_URL = process.env.LLAMA_BASE_URL || LOCAL_LLM_BASE;
  const app = createServer(cfg);
  // 2026-08-11：启动后公共逻辑（日志 + 本地引擎恢复 + 索引一致性校验）——http/https 共用
  const afterListen = (proto: string, port: number) => {
    // 安全自检（P0-3，2026-08-13）：生产环境关键安全配置未达标时警告（不阻断启动，只提醒——避免误伤开发/测试）
    if (process.env.NODE_ENV === 'production') {
      if (cfg.authMode !== 'production') console.warn(`[security] ⚠️ 生产环境 AUTH_MODE=${cfg.authMode}（应为 production——X-User-Id 后门开启，任何人可伪装身份！）`);
      if (!process.env.POLICYBOT_INITIAL_PASSWORD) console.warn('[security] ⚠️ 生产环境未设置 POLICYBOT_INITIAL_PASSWORD（初始密码为公开默认 Pass1234）');
      if (!process.env.POLICYBOT_MASTER_KEY) console.warn('[security] ⚠️ 生产环境未设置 POLICYBOT_MASTER_KEY（密钥将自动生成落盘，不合规 B3）');
    }
    console.log(`[backend] up on ${proto}://localhost:${port}`);
    console.log(`[backend] sqlite: ${cfg.sqlitePath}`);
    console.log(`[backend] deepseek key: ${cfg.deepseek.apiKey ? 'configured' : 'unconfigured'}`);
    // 2026-08-09：启动时自动恢复本地模型引擎（mode=local 且已选模型 → 托管拉起 llama-server；模型加载约 30-60s，异步不阻塞）
    try {
      const row = getDb().prepare("SELECT mode, model_file FROM llm_config WHERE id=1").get() as { mode: string; model_file: string } | undefined;
      if (row?.mode === 'local' && row.model_file) {
        const r = startLocalLLM();
        console.log(`[local-llm] 启动时自动恢复本地引擎：${r.ok ? '已拉起（模型加载约 30-60s）' : r.error}`);
      }
    } catch (e: any) { console.error(`[local-llm] 启动恢复失败：${e?.message ?? e}`); }
    // 启动索引一致性校验（ISSUE #33 根治）：失败不静默，Python 未就绪则重试（最多 3 次，间隔 5s）
    const trySync = (attempt: number) => {
      syncIndexFromDb().then((r) => {
        if (r.failed) console.error(`[backend] 索引同步有 ${r.failed} 条失败（cleaned ${r.cleaned}），可运行 scripts/sync-index.mjs 手动清理重试`);
        else if (r.cleaned) console.log(`[backend] synced: cleared ${r.cleaned} stale vectors`);
      }).catch((e) => {
        if (attempt < 3) { console.error(`[backend] 索引同步异常（第 ${attempt} 次）: ${e?.message ?? e}，5s 后重试`); setTimeout(() => trySync(attempt + 1), 5000); }
        else console.error(`[backend] 索引同步失败 3 次，请检查 Python 服务后运行 scripts/sync-index.mjs`);
      });
    };
    trySync(1);
  };
  // 2026-08-11：HTTPS（S8 部署前置）——HTTPS_ENABLED=1 开启；证书缺失/不可读 → 明确报错退出（防"以为开了其实没开"），提示生成命令
  if (cfg.https.enabled) {
    try {
      const cert = fs.readFileSync(cfg.https.cert);
      const key = fs.readFileSync(cfg.https.key);
      const server = https.createServer({ cert, key }, app);
      server.listen(cfg.https.port, cfg.bindHost, () => { afterListen('https', cfg.https.port); console.log(`[backend] 证书: ${cfg.https.cert}`); });
    } catch (e: any) {
      console.error(`[https] 证书缺失或不可读（${cfg.https.cert} / ${cfg.https.key}）：${e?.message ?? e}`);
      console.error('[https] 请运行 node scripts/gen-cert.mjs 生成自签名证书，或通过 HTTPS_CERT / HTTPS_KEY 指定正式证书路径');
      process.exit(1);
    }
    return;
  }
  app.listen(cfg.port, cfg.bindHost, () => afterListen('http', cfg.port));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}