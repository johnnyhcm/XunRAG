// 密级体系服务（2026-08-12，PRD §4.5.4 / TECH §3.6.x）
// - 档位：field_dicts.security_level 选项（客户可配）
// - 策略：app_configs.security.policy（json：{档位: {watermark, copy_protect, ai_searchable, audit_read, audit_denied}}）
// - 消费：ai_searchable → AI 检索硬过滤（高效/智能同源）；watermark/copy_protect → 前端阅读页；audit_read/audit_denied → 浏览审计
import { getDb } from '../db/index.js';
import { getConfig } from './config.js';

export interface SecurityLevel {
  value: string;
  label: string;
  /** 英文标签（2026-08-13：en 界面显示 label_en ?? label） */
  label_en?: string | null;
  sort: number;
  enabled: boolean;
}
export interface SecurityPolicyEntry {
  watermark: boolean;
  copy_protect: boolean;
  ai_searchable: boolean;
  audit_read: boolean;
  audit_denied: boolean;
}

const POLICY_DEFAULT: Record<string, SecurityPolicyEntry> = {
  public: { watermark: false, copy_protect: false, ai_searchable: true, audit_read: false, audit_denied: false },
  internal: { watermark: false, copy_protect: true, ai_searchable: true, audit_read: false, audit_denied: true },
  confidential: { watermark: true, copy_protect: true, ai_searchable: false, audit_read: true, audit_denied: true },
  top_secret: { watermark: true, copy_protect: true, ai_searchable: false, audit_read: true, audit_denied: true },
};

/** 密级档位列表（app_configs.security.levels，安全设置页维护——独立于用户属性 field_dicts，2026-08-12 修正） */
export function getSecurityLevels(): SecurityLevel[] {
  const raw = getConfig('security.levels');
  const fallback: SecurityLevel[] = [
    { value: '公开', label: '公开', sort: 0, enabled: true },
    { value: '内部', label: '内部', sort: 1, enabled: true },
    { value: '机密', label: '机密', sort: 2, enabled: true },
    { value: '绝密', label: '绝密', sort: 3, enabled: true },
  ];
  if (raw) {
    try {
      const arr = JSON.parse(raw) as any[];
      if (Array.isArray(arr) && arr.length) {
        return arr.map((l) => ({ value: String(l.value ?? ''), label: String(l.label ?? l.value ?? ''), label_en: l.label_en ? String(l.label_en) : null, sort: Number(l.sort) || 0, enabled: l.enabled !== false })).filter((l) => l.value);
      }
    } catch { /* 损坏回退 */ }
  }
  return fallback;
}

/** 按请求语言本地化档位 label（en → label_en ?? label） */
export function localizeLevels(levels: SecurityLevel[], req: any): SecurityLevel[] {
  const en = String(req?.headers?.['accept-language'] ?? '').toLowerCase().startsWith('en');
  if (!en) return levels;
  return levels.map((l) => ({ ...l, label: l.label_en ?? l.label }));
}

/** 密级策略（value → default → 内置默认；档位未配置时套默认"内部"档策略） */
export function getSecurityPolicy(): Record<string, SecurityPolicyEntry> {
  const raw = getConfig('security.policy');
  if (raw) {
    try {
      const obj = JSON.parse(raw) as Record<string, Partial<SecurityPolicyEntry>>;
      const out: Record<string, SecurityPolicyEntry> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object') {
          out[k] = {
            watermark: !!v.watermark,
            copy_protect: !!v.copy_protect,
            ai_searchable: v.ai_searchable !== false, // 默认 true（可检索），只有显式 false 才禁
            audit_read: !!v.audit_read,
            audit_denied: !!v.audit_denied,
          };
        }
      }
      return out;
    } catch { /* 损坏 JSON 回退默认 */ }
  }
  return POLICY_DEFAULT;
}

/** 某密级的策略（档位不存在 → 返回默认"内部"策略——安全优先，未配置按内部处理） */
export function getLevelPolicy(level: string | null | undefined): SecurityPolicyEntry {
  if (!level) return { watermark: false, copy_protect: true, ai_searchable: true, audit_read: false, audit_denied: true }; // 无密级=默认内部行为
  return getSecurityPolicy()[level] ?? POLICY_DEFAULT[level] ?? POLICY_DEFAULT['internal'];
}

/** AI 可检索过滤（2026-08-12）：可见集合 ∩ (无密级 或 密级策略 ai_searchable=true)
 *  含系统管理员——"人可读、AI 不引用"（AI 引用是批量化、上下文无关的，泄露面远大于人主动去看） */
export function getSearchableLineIds(user: { id: string } | null, visibleLineIds: string[]): string[] {
  if (!visibleLineIds.length) return [];
  const db = getDb();
  const rows = db.prepare(`SELECT id, security_level FROM policy_lines WHERE id IN (${visibleLineIds.map(() => '?').join(',')})`)
    .all(...visibleLineIds) as { id: string; security_level: string | null }[];
  const searchable = new Set<string>();
  for (const r of rows) {
    if (getLevelPolicy(r.security_level).ai_searchable) searchable.add(r.id);
  }
  return visibleLineIds.filter((id) => searchable.has(id));
}
