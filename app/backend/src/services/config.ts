// 配置读取服务（配置中心，PRD §4.4.9 / TECH.md §3.8）
// 读取优先级：env（运维覆盖）→ app_configs.value（非 NULL）→ default_value → 代码常量兜底
// 进程内缓存 + 变更失效（invalidateConfigCache）
import { getDb } from '../db/index.js';

/** env 最高优先级覆盖映射（运维入口，S7 前台化后保留） */
const ENV_MAP: Record<string, string> = {
  'efficient.retrieve.top_k': 'POLICYBOT_TOPK',
  'efficient.retrieve.hybrid': 'POLICYBOT_HYBRID',
  'efficient.retrieve.rerank': 'POLICYBOT_RERANK',
  'efficient.generate.max_rounds': 'EFFICIENT_MAX_ROUNDS',
};

let cache: Map<string, string | null> | null = null;
let cacheEn: Map<string, string | null> | null = null;

function loadAll(): Map<string, string | null> {
  if (cache) return cache;
  try {
    const db = getDb();
    const rows = db.prepare('SELECT key, value, default_value FROM app_configs').all() as { key: string; value: string | null; default_value: string }[];
    cache = new Map(rows.map((r) => [r.key, r.value ?? r.default_value]));
  } catch {
    cache = new Map();
  }
  return cache;
}

function loadAllEn(): Map<string, string | null> {
  if (cacheEn) return cacheEn;
  try {
    const db = getDb();
    const rows = db.prepare('SELECT key, value_en FROM app_configs').all() as { key: string; value_en: string | null }[];
    cacheEn = new Map(rows.map((r) => [r.key, r.value_en ?? null]));
  } catch {
    cacheEn = new Map();
  }
  return cacheEn;
}

/** 配置变更后调用（配置 API 写入时） */
export function invalidateConfigCache(): void {
  cache = null;
  cacheEn = null;
}

export function getConfig(key: string, fallback?: string): string | null {
  const envName = ENV_MAP[key];
  if (envName && process.env[envName] !== undefined) return process.env[envName] as string;
  const v = loadAll().get(key);
  return v ?? fallback ?? null;
}

/** 按语言读取配置文案（2026-08-13）：lang=en 时优先 value_en ?? 中文 value；zh/其他 → 中文 value。用于后端生成回答时消费的文案（转人工/拒答/反问等） */
export function getConfigLocalized(key: string, lang?: string, fallback?: string): string | null {
  if (lang === 'en') {
    const en = loadAllEn().get(key);
    if (en) return en;
  }
  return getConfig(key, fallback);
}

export function getNumber(key: string, fallback: number): number {
  const v = getConfig(key);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function getBool(key: string, fallback: boolean): boolean {
  const v = getConfig(key);
  if (v === null) return fallback;
  return v === '1' || v === 'true';
}

export function getList(key: string, fallback: string[]): string[] {
  const v = getConfig(key);
  if (!v) return fallback;
  try {
    const arr = JSON.parse(v) as unknown;
    return Array.isArray(arr) ? arr.map(String) : fallback;
  } catch {
    return fallback;
  }
}
