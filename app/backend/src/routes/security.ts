// 安全设置路由（2026-08-12，PRD §4.5.4）——密级体系（档位+策略矩阵）+ 审计日志目录
// GET  /api/security/config         → { levels: 档位列表, policy: 策略矩阵, watermark_enabled, copy_protect_enabled, audit_dir }
// PUT  /api/security/policy         → 保存策略矩阵 { policy: {档位: {watermark,...}} }
// GET  /api/security/audit-files    → audit 目录按天文件列表（文件名/大小/日期）
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { getConfig, invalidateConfigCache } from '../services/config.js';
import { getSecurityPolicy, getSecurityLevels, localizeLevels } from '../services/security.js';
import { hasPerm } from '../services/permission.js';
import { logger } from '../services/logger.js';
import { E, sendErr } from '../services/errors.js';

export const securityRouter = Router();

const AUDIT_DIR = path.join(config.root, 'data', 'logs', 'audit');

/** 权限：config_mgmt（系统配置） */
function requireConfig(req: any, res: any): boolean {
  if (!hasPerm(req.user ?? null, 'config_mgmt')) {
    sendErr(req, res, 403, E('PERM_CONFIG', '无权限（需要系统配置权限）', 'No permission (requires system configuration)'));
    return false;
  }
  return true;
}

// GET /api/security/levels —— 密级档位（供政策编辑表单下拉 + 密级气泡显示名映射）
// 2026-08-12 修复：显示名映射不得依赖 policy_mgmt 权限（A001/AA01 显示不一致根因）——档位名是公开元数据，登录即可读
// 2026-08-13：en 请求 label 用 label_en ?? label
securityRouter.get('/security/levels', (req, res) => {
  if (!req.user) return sendErr(req, res, 403, E('AUTH_NOT_LOGGED_IN', '请先登录', 'Not logged in'));
  res.json({ levels: localizeLevels(getSecurityLevels().filter((l) => l.enabled), req) });
});

// GET /api/security/config
securityRouter.get('/security/config', (req, res) => {
  if (!requireConfig(req, res)) return;
  const policy = getSecurityPolicy();
  // 各档位被存量政策引用数（2026-08-12：in_use>0 的档位键不可改/不可删，防密级断链）
  const useCount = new Map<string, number>();
  try {
    const rows = getDb().prepare('SELECT security_level, COUNT(*) c FROM policy_lines WHERE security_level IS NOT NULL AND security_level != \'\' GROUP BY security_level').all() as { security_level: string; c: number }[];
    for (const r of rows) useCount.set(r.security_level, r.c);
  } catch { /* 忽略 */ }
  res.json({
    levels: localizeLevels(getSecurityLevels().map((l) => ({ ...l, in_use: useCount.get(l.value) ?? 0 })), req),
    policy,
    watermark_enabled: getConfig('common.security.watermark_enabled', '1'),
    copy_protect_enabled: getConfig('common.security.copy_protect_enabled', '1'),
    force_change_on_first_login: getConfig('common.security.force_change_on_first_login', '0'), // 2026-08-13：安全入口收敛，问答配置页不再显示，安全设置页唯一入口
    audit_dir: AUDIT_DIR,
  });
});

// PUT /api/security/levels —— 档位管理（增删改停；安全设置页维护，独立于用户属性 field_dicts）
securityRouter.put('/security/levels', (req, res) => {
  if (!requireConfig(req, res)) return;
  const { levels } = req.body ?? {};
  if (!Array.isArray(levels) || !levels.length) return sendErr(req, res, 400, E('SEC_LEVELS_REQUIRED', 'levels 必须为非空数组', 'levels must be a non-empty array'));
  const seen = new Set<string>();
  for (const l of levels) {
    if (!l || typeof l.value !== 'string' || !l.value.trim()) return sendErr(req, res, 400, E('SEC_LEVEL_VALUE_REQUIRED', '档位 value 必填', 'Level value is required'));
    if (seen.has(l.value)) return sendErr(req, res, 400, E('SEC_LEVEL_DUPLICATE', `档位「${l.value}」重复`, `Level ${l.value} is duplicated`));
    seen.add(l.value);
    if (typeof l.label !== 'string' || !l.label.trim()) return sendErr(req, res, 400, E('SEC_LEVEL_LABEL_REQUIRED', `档位「${l.value}」label 必填`, `Level ${l.value} label is required`));
  }
  // 删除保护（2026-08-12）：被存量政策引用的档位禁止删除（只能停用）——删除会让存量政策密级断链、策略回退默认"内部"（绝密降级泄露）
  const db = getDb();
  const inUse = db.prepare('SELECT DISTINCT security_level FROM policy_lines WHERE security_level IS NOT NULL AND security_level != \'\'').all() as { security_level: string }[];
  const oldLevels = getSecurityLevels();
  const removed = oldLevels.filter((o) => !levels.some((l) => l.value === o.value));
  const blocked = removed.filter((r) => inUse.some((u) => u.security_level === r.value));
  if (blocked.length) {
    return sendErr(req, res, 400, E('SEC_LEVEL_IN_USE_DELETE', `档位「${blocked.map((b) => b.label).join('、')}」仍被政策引用，禁止删除——请改为「停用」（存量政策策略继续生效）`, `Level(s) ${blocked.map((b) => b.label).join('、')} still referenced by policies; deletion is forbidden — disable instead (existing policy tiers remain effective)`));
  }
  // 改键保护（2026-08-12）：被引用的档位 value 不可修改（改键=换档位，存量政策断链）
  const renamed = oldLevels.filter((o) => {
    const nl = levels.find((l) => l.value === o.value);
    if (nl) return false;
    // value 变了：检查是否被引用（被引用则拒绝；未引用视为删除+新增，已由删除保护处理）
    return inUse.some((u) => u.security_level === o.value);
  });
  if (renamed.length) {
    return sendErr(req, res, 400, E('SEC_LEVEL_KEY_LOCKED', `档位「${renamed.map((b) => b.label).join('、')}」仍被政策引用，档位键不可修改（已按删除处理）——请先停用或迁移政策密级`, `Level(s) ${renamed.map((b) => b.label).join('、')} still referenced by policies; level key cannot be changed (handled as delete) — disable or migrate policy levels first`));
  }
  db.prepare(`UPDATE app_configs SET value=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE key='security.levels'`)
    .run(JSON.stringify(levels.map((l) => ({ value: l.value.trim(), label: l.label.trim(), label_en: typeof l.label_en === 'string' && l.label_en.trim() ? l.label_en.trim() : null, sort: Number(l.sort) || 0, enabled: l.enabled !== false }))));
  invalidateConfigCache();
  logger.audit({ action: 'save_security_levels', levels: levels.length, sessionId: req.sessionId });
  res.json({ ok: true, levels: getSecurityLevels() });
});

// PUT /api/security/policy —— 保存策略矩阵
securityRouter.put('/security/policy', (req, res) => {
  if (!requireConfig(req, res)) return;
  const { policy } = req.body ?? {};
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return sendErr(req, res, 400, E('SEC_POLICY_FORMAT', 'policy 必须为对象 {档位: {watermark, copy_protect, ai_searchable, audit_read, audit_denied}}', 'policy must be an object {level: {watermark, copy_protect, ai_searchable, audit_read, audit_denied}}'));
  }
  // 校验字段合法性
  const KEYS = ['watermark', 'copy_protect', 'ai_searchable', 'audit_read', 'audit_denied'];
  for (const [level, entry] of Object.entries(policy as Record<string, any>)) {
    if (!entry || typeof entry !== 'object') return sendErr(req, res, 400, E('SEC_LEVEL_ENTRY_FORMAT', `档位「${level}」策略格式错误`, `Level ${level} policy format error`));
    for (const k of KEYS) if (typeof entry[k] !== 'boolean') return sendErr(req, res, 400, E('SEC_LEVEL_ENTRY_BOOL', `档位「${level}」${k} 必须为布尔`, `Level ${level} ${k} must be boolean`));
  }
  const db = getDb();
  db.prepare(`UPDATE app_configs SET value=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE key='security.policy'`).run(JSON.stringify(policy));
  invalidateConfigCache();
  logger.audit({ action: 'save_security_policy', levels: Object.keys(policy).length, sessionId: req.sessionId });
  res.json({ ok: true, policy: getSecurityPolicy() });
});

// GET /api/security/audit-files —— audit 目录按天文件列表（只读）
securityRouter.get('/security/audit-files', (req, res) => {
  if (!requireConfig(req, res)) return;
  try {
    if (!fs.existsSync(AUDIT_DIR)) return res.json({ dir: AUDIT_DIR, files: [] });
    const files = fs.readdirSync(AUDIT_DIR)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const st = fs.statSync(path.join(AUDIT_DIR, f));
        return { name: f, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.name < b.name ? 1 : -1));
    res.json({ dir: AUDIT_DIR, files });
  } catch (e: any) {
    sendErr(req, res, 500, E('SEC_AUDIT_DIR_READ_FAILED', '读取审计目录失败：' + (e?.message ?? e), 'Failed to read audit directory: ' + (e?.message ?? e)));
  }
});

// GET /api/security/audit-log?file=2026-08-12.log&action=read_policy&user=admin&limit=200
// 审计日志内容查看（2026-08-12，替代无用文件列表）：解析指定文件 JSONL + 过滤（action/用户）+ 分页
securityRouter.get('/security/audit-log', (req, res) => {
  if (!requireConfig(req, res)) return;
  const file = String(req.query.file ?? '').replace(/[^\w.-]/g, '');
  if (!file.endsWith('.log')) return sendErr(req, res, 400, E('FIELD_FILE_INVALID', 'file 参数非法', 'file parameter is invalid'));
  const fp = path.join(AUDIT_DIR, file);
  if (!fs.existsSync(fp)) return sendErr(req, res, 404, E('SEC_LOG_FILE_MISSING', '日志文件不存在', 'Log file does not exist'));
  const action = String(req.query.action ?? '');
  const user = String(req.query.user ?? '');
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  try {
    // 历史日志无 userName → 从 users 表补映射（id/employee_no → name）
    const userMap = new Map<string, string>();
    try {
      const us = getDb().prepare('SELECT id, name, employee_no FROM users').all() as { id: string; name: string; employee_no: string | null }[];
      for (const u of us) { userMap.set(u.id, u.name); if (u.employee_no) userMap.set(u.employee_no, u.name); }
    } catch { /* 忽略 */ }
    const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
    const rows = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (action && obj.action !== action) continue;
        if (user && !String(obj.userId ?? obj.employeeNo ?? '').includes(user)) continue;
        const uid = obj.userId ?? null;
        rows.push({
          ts: obj.ts ?? '', action: obj.action ?? '', userId: uid,
          userName: obj.userName ?? (uid ? (userMap.get(uid) ?? null) : null),
          employeeNo: obj.employeeNo ?? null,
          lineName: obj.lineName ?? null, security_level: obj.security_level ?? null,
          detail: JSON.stringify(obj).slice(0, 300),
        });
        if (rows.length >= limit) break;
      } catch { /* 跳过损坏行 */ }
    }
    res.json({ file, total: rows.length, rows });
  } catch (e: any) {
    sendErr(req, res, 500, E('SEC_LOG_READ_FAILED', '读取日志失败：' + (e?.message ?? e), 'Failed to read log: ' + (e?.message ?? e)));
  }
});
