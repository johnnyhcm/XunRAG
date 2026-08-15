// 后端运行配置（工程参数走配置文件，不暴露给管理员 —— PRD §5.4）
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..', '..', '..');

/** DeepSeek API key 文件（S0 验证用的 key 文件路径） */
function loadDeepseekKey(): string | null {
  const candidates = [
    process.env.DEEPSEEK_API_KEY,
    process.env.DEEPSEEK_KEY,
  ].filter(Boolean) as string[];
  if (candidates.length) return candidates[0];

  const keyFile = path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.policybot-secrets',
    'deepseek.key',
  );
  try {
    if (fs.existsSync(keyFile)) {
      return fs.readFileSync(keyFile, 'utf8').trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}

export const config = {
  root,
  port: Number(process.env.PORT) || 3000,
  /** 监听地址（2026-08-11）：默认 127.0.0.1 不外露——局域网访问只经前端 https 端口；生产部署用 BIND_HOST=0.0.0.0 */
  bindHost: process.env.BIND_HOST || '127.0.0.1',
  /** HTTPS（2026-08-11，S8 部署前置）：HTTPS_ENABLED=1 开启；证书默认 data/certs/（node scripts/gen-cert.mjs 生成自签）；生产用 HTTPS_CERT/HTTPS_KEY 指定正式证书 */
  https: {
    enabled: process.env.HTTPS_ENABLED === '1' || process.env.HTTPS_ENABLED === 'true',
    cert: process.env.HTTPS_CERT || path.join(root, 'data', 'certs', 'server.crt'),
    key: process.env.HTTPS_KEY || path.join(root, 'data', 'certs', 'server.key'),
    port: Number(process.env.HTTPS_PORT) || 3443,
  },
  /** SQLite 单文件（PRD §6 / TECH.md §2 better-sqlite3） */
  sqlitePath: process.env.SQLITE_PATH || path.join(root, 'data', 'policybot.db'),
  /** Python 检索引擎（S3 起接入，S1 未启动） */
  pythonBaseUrl: process.env.PYTHON_BASE_URL || 'http://localhost:8001',
  deepseek: {
    apiKey: loadDeepseekKey(),
    /** 模型名（2026-08-06 定案）：官方预告 deepseek-chat/deepseek-reasoner 三个月后停用，
     *  当前已指向 v4-flash 的非思考/思考模式。高效模式迁到 deepseek-v4-flash + reasoning_effort:'none'
     *  （非思考模式，见 deepseek.ts）；智能模式（Pi SDK）用 deepseek-v4-flash 思考模式（定位"深而全"）。
     *  env DEEPSEEK_MODEL 为运维最高优先级覆盖 */
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  },
  isProd: process.env.NODE_ENV === 'production',
  /** 认证模式（S6 完整用户系统，2026-08-07；2026-08-11 默认改 production——关闭 X-User-Id 降级后门，未登录=匿名必须登录）：demo=无 token 时 X-User-Id 身份切换器降级（仅显式测试用）；production=无 token → 匿名零可见，必须登录 */
  authMode: (process.env.AUTH_MODE || 'production') as 'demo' | 'production',
} as const;

export type AppConfig = typeof config;