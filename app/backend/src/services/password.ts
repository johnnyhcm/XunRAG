// 密码服务（S6 完整用户系统，2026-08-07）—— node:crypto scrypt，零第三方依赖
// 存储格式：scrypt$<salt hex>$<hash hex>（salt 随机 16B，hash 64B）
import crypto from 'node:crypto';

// 初始密码（P0-2，2026-08-13）：从环境变量读——生产部署必须设 POLICYBOT_INITIAL_PASSWORD（非公开随机密码）；
// 默认 Pass1234 仅供开发/测试便利，生产部署脚本应强制覆盖（见 install-services.ps1 自检）
export const INITIAL_PASSWORD = process.env.POLICYBOT_INITIAL_PASSWORD ?? 'Pass1234';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  try {
    const expect = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, 64);
    if (actual.length !== expect.length) return false;
    return crypto.timingSafeEqual(actual, expect);
  } catch {
    return false;
  }
}
