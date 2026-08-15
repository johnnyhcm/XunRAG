// secrets 服务（S7 ⑤ 模型接入，2026-08-09 B3 合规定稿）—— node:crypto 原生，零第三方依赖
// - API key 加密写文件 ~/.policybot-secrets/llm.key.enc（AES-256-GCM，明文永不落盘/落库）
// - 加密密钥 = 环境变量 POLICYBOT_MASTER_KEY（32B，管理员部署注入）：不自动生成、不落盘、不进 DB/日志/代码库
//   ——满足"密钥不得明文存储"合规；进程启动读入内存；守护重启自动恢复
// - 开发兜底（2026-08-10 方案 A）：env 未设时允许读旧 master.key 文件；文件也不存在时自动生成落盘（仅开发便利；生产禁用）
// - 密文格式 aes-gcm$<iv hex>$<tag hex>$<cipher hex>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SECRETS_DIR = process.env.POLICYBOT_SECRETS_DIR || path.join(os.homedir(), '.policybot-secrets');
const MASTER_KEY_ENV = 'POLICYBOT_MASTER_KEY'; // 加密密钥（管理员部署注入）
const LEGACY_KEY_FILE = path.join(SECRETS_DIR, 'master.key'); // 旧实现自动生成的文件（仅开发兜底）
export const API_KEY_FILE = path.join(SECRETS_DIR, 'llm.key.enc'); // API key 密文文件

let masterKey: Buffer | null = null;
let masterKeyResolved = false;

/** 读取加密密钥：env POLICYBOT_MASTER_KEY →（开发兜底）旧 master.key 文件 →（开发兜底）自动生成落盘 → null
 *  生产（NODE_ENV=production）无 env → 明确 null（不落盘生成，密钥分离合规）
 *  2026-08-11：开发兜底条件从 AUTH_MODE 解耦到 NODE_ENV——AUTH_MODE 现专注 X-User-Id 身份降级（默认 production），不再兼任密钥兜底开关 */
export function getMasterKey(): Buffer | null {
  if (masterKeyResolved) return masterKey;
  masterKeyResolved = true;
  const env = process.env[MASTER_KEY_ENV];
  if (env) { masterKey = Buffer.from(env.trim(), 'hex'); return masterKey; }
  // 2026-08-11：开发兜底（读旧 master.key + 自动生成）由 NODE_ENV 控制（默认未设=开发）——与 AUTH_MODE 解耦
  if (process.env.NODE_ENV !== 'production') {
    try {
      if (fs.existsSync(LEGACY_KEY_FILE)) { masterKey = fs.readFileSync(LEGACY_KEY_FILE); return masterKey; }
    } catch { /* ignore */ }
    // 2026-08-10 方案 A：开发兜底自动生成（B3"不自动生成"仅限生产；开发环境零手工 + 重启后密钥稳定）
    try {
      const k = crypto.randomBytes(32);
      fs.mkdirSync(SECRETS_DIR, { recursive: true });
      fs.writeFileSync(LEGACY_KEY_FILE, k, { mode: 0o600 });
      console.warn(`[secrets] 开发模式：未检测到 ${MASTER_KEY_ENV}，已自动生成加密密钥 ${LEGACY_KEY_FILE}（仅开发便利；生产环境（NODE_ENV=production）必须设置 ${MASTER_KEY_ENV} 环境变量）`);
      masterKey = k;
      return masterKey;
    } catch (e: any) {
      console.error(`[secrets] 自动生成 master.key 失败：${e?.message ?? e}`);
      return null;
    }
  }
  return null;
}

/** 加密密钥是否已配置（界面提示用） */
export function hasMasterKey(): boolean {
  return getMasterKey() !== null;
}

/** 对称加密（AES-256-GCM），返回 aes-gcm$<iv>$<tag>$<cipher>；密钥未配置 → null */
export function encryptSecret(plain: string): string | null {
  const key = getMasterKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `aes-gcm$${iv.toString('hex')}$${tag.toString('hex')}$${enc.toString('hex')}`;
}

/** 解密（格式不符/密钥不符/未配置 → null，不抛错） */
export function decryptSecret(enc: string | null | undefined): string | null {
  if (!enc) return null;
  const parts = String(enc).split('$');
  if (parts.length !== 4 || parts[0] !== 'aes-gcm') return null;
  const key = getMasterKey();
  if (!key) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'hex'));
    decipher.setAuthTag(Buffer.from(parts[2], 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'hex')), decipher.final()]).toString('utf8');
  } catch {
    return null; // 密钥轮换/格式损坏 → 视为未配置，不崩服务
  }
}

/** 掩码：sk-****后4位；短 key 只显示前2+后2 */
export function maskSecret(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const p = String(plain);
  if (p.length <= 8) return `${p.slice(0, 2)}****`;
  return `${p.slice(0, 4)}****${p.slice(-4)}`;
}

// ---------- API key 加密文件读写（B3：key 落文件不落 DB） ----------
// 2026-08-10：按服务商分文件存储 llm.key.<provider>.enc——换服务商各自 key 独立保留，不重填
// 兼容：旧单文件 llm.key.enc（B3 首版）→ 首次访问 deepseek 时迁移为 llm.key.deepseek.enc
const PROVIDERS = ['openai', 'anthropic', 'deepseek', 'custom'] as const;

/** 某服务商的 key 密文文件路径（provider 缺省 → deepseek） */
export function apiKeyFilePath(provider?: string | null): string {
  const p = (provider && PROVIDERS.includes(provider as any)) ? provider : 'deepseek';
  return path.join(SECRETS_DIR, `llm.key.${p}.enc`);
}

/** 存量迁移：旧单文件 llm.key.enc → llm.key.deepseek.enc（文件存在且目标不存在时 rename；调用方负责确保 master key 可用） */
export function migrateLegacyKeyFile(): void {
  try {
    if (fs.existsSync(API_KEY_FILE) && !fs.existsSync(apiKeyFilePath('deepseek'))) {
      fs.renameSync(API_KEY_FILE, apiKeyFilePath('deepseek'));
      console.log('[secrets] 旧单文件 llm.key.enc 已迁移为 llm.key.deepseek.enc');
    }
  } catch { /* 迁移失败不阻塞（下次再试） */ }
}

/** 读 API key：解密 llm.key.<provider>.enc；无文件/密钥不符 → null */
export function readApiKeyFile(provider?: string | null): string | null {
  migrateLegacyKeyFile(); // 幂等：首次访问时迁移旧文件
  const file = apiKeyFilePath(provider);
  try {
    if (!fs.existsSync(file)) return null;
    const enc = fs.readFileSync(file, 'utf8').trim();
    return decryptSecret(enc);
  } catch { return null; }
}

/** 写 API key：加密写 llm.key.<provider>.enc（自动建目录/文件）；密钥未配置 → 返回 false */
export function writeApiKeyFile(plain: string, provider?: string | null): boolean {
  const enc = encryptSecret(plain);
  if (!enc) return false;
  try {
    fs.mkdirSync(SECRETS_DIR, { recursive: true });
    fs.writeFileSync(apiKeyFilePath(provider), enc, { mode: 0o600 });
    return true;
  } catch { return false; }
}

/** 清空某服务商 API key 文件 */
export function clearApiKeyFile(provider?: string | null): void {
  try { if (fs.existsSync(apiKeyFilePath(provider))) fs.unlinkSync(apiKeyFilePath(provider)); } catch { /* ignore */ }
}

/** 各服务商 key 配置状态（掩码/是否已配置）——界面换服务商时展示，避免重填 */
export function listApiKeyStatus(): Record<string, { has_key: boolean; masked: string | null }> {
  const out: Record<string, { has_key: boolean; masked: string | null }> = {};
  for (const p of PROVIDERS) {
    const plain = readApiKeyFile(p);
    out[p] = { has_key: Boolean(plain), masked: maskSecret(plain) };
  }
  return out;
}
