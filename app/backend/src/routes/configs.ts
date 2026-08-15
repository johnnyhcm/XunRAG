// 配置中心 API（PRD §4.4.9 / TECH.md §3.8）
// GET  /api/configs                    全部配置项（含默认值/类型/变量说明/选项）——只读，员工首页（建议问题/阶段文案）也读，不设权限
// PUT  /api/configs/:key               更新配置值（value=NULL 重置默认）——需 config_mgmt（2026-08-09 补权限，原无校验任何人可改）
// GET  /api/configs/dicts/:name        数据字典列表（topics/intents/processes/routes）——只读开放
// POST /api/configs/dicts/:name        新增字典项——需 config_mgmt
// PUT  /api/configs/dicts/:name/:id    更新字典项——需 config_mgmt
// DELETE /api/configs/dicts/:name/:id  删除字典项——需 config_mgmt
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { invalidateConfigCache } from '../services/config.js';
import { requireFn } from '../services/permission.js';
import { newId } from '../db/repo.js';
import { E, sendErr } from '../services/errors.js';

export const configRouter = Router();

// 数据字典元信息（表名/可编辑列）
const DICTS: Record<string, { table: string; idCol: string; editable: string[] }> = {
  topics: { table: 'policy_topics', idCol: 'id', editable: ['name', 'name_en', 'keywords', 'scope', 'sort', 'enabled', 'description'] },
  intents: { table: 'intent_types', idCol: 'id', editable: ['name', 'name_en', 'prompt_desc', 'sort', 'enabled', 'description'] },
  processes: { table: 'processes', idCol: 'id', editable: ['name', 'name_en', 'url', 'topic_id', 'keywords', 'sort', 'enabled', 'description'] },
  routes: { table: 'topic_routes', idCol: 'id', editable: ['topic_id', 'region', 'contact_user_id', 'sort', 'enabled', 'description'] },
};

// GET /api/configs —— 全部配置项（2026-08-13：en 请求时 value/value_en 优先、label/description 用 label_en/description_en 输出；2026-08-14：返回 i18n 标记 + value_zh/value_en 供配置页双语编辑，en 合并逻辑保留到 value——现有消费方零改动）
configRouter.get('/configs', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT key, module, section, label, label_en, type, value, default_value, value_en, i18n, variables, options, description, description_en, sort
     FROM app_configs WHERE hidden IS NOT 1 ORDER BY module, sort`,
  ).all();
  const en = String(req.headers['accept-language'] ?? '').toLowerCase().startsWith('en');
  res.json({ configs: rows.map((r: any) => ({
    ...r,
    value: en ? (r.value_en ?? r.value) : r.value,          // 兼容现有消费方（HomePage 等）：en 请求时 value 已本地化
    value_zh: r.value,                                       // 2026-08-14：原始中文值（配置页双语编辑用）
    value_en: r.value_en ?? null,                            // 2026-08-14：原始英文值
    default_value: en ? (r.value_en ?? r.default_value) : r.default_value,
    label: en ? (r.label_en ?? r.label) : r.label,
    description: en ? (r.description_en ?? r.description) : r.description,
  })) });
});

// PUT /api/configs/:key —— 更新配置（value 传 null/undefined 表示重置默认；2026-08-14：支持 value_en 同次提交——i18n 文案项双语维护）
configRouter.put('/configs/:key', requireFn('config_mgmt'), (req, res) => {
  const db = getDb();
  const key = req.params.key;
  const exists = db.prepare('SELECT key FROM app_configs WHERE key=?').get(key);
  if (!exists) return sendErr(req, res, 404, E('CONFIG_NOT_FOUND', '配置项不存在', 'Configuration item not found'));
  const body = req.body ?? {};
  const sets: string[] = [];
  const vals: any[] = [];
  if ('value' in body) { sets.push('value=?'); vals.push(body.value === undefined || body.value === null ? null : String(body.value)); }
  if ('value_en' in body) { sets.push('value_en=?'); vals.push(body.value_en === undefined || body.value_en === null ? null : String(body.value_en)); }
  if (!sets.length) return res.json({ ok: true });
  sets.push("updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')", 'updated_by=?');
  vals.push(req.sessionId ?? null, key);
  db.prepare(`UPDATE app_configs SET ${sets.join(',')} WHERE key=?`).run(...vals);
  invalidateConfigCache();
  res.json({ ok: true, key });
});

// GET /api/configs/dicts/:name —— 字典列表（2026-08-13：en 请求时 name/topic_name 用 name_en ?? name 输出——数据字典统一 _en 双列）
configRouter.get('/configs/dicts/:name', (req, res) => {
  const meta = DICTS[req.params.name];
  if (!meta) return sendErr(req, res, 404, E('DICT_NOT_FOUND', '字典不存在', 'Dictionary not found'));
  const db = getDb();
  const en = String(req.headers['accept-language'] ?? '').toLowerCase().startsWith('en');
  let rows;
  if (req.params.name === 'routes') {
    // 关联展示主题名/联系人名
    rows = db.prepare(`SELECT tr.*, pt.name AS topic_name, pt.name_en AS topic_name_en, u.name AS contact_name
      FROM topic_routes tr LEFT JOIN policy_topics pt ON pt.id=tr.topic_id
      LEFT JOIN users u ON u.id=tr.contact_user_id ORDER BY tr.sort`).all();
    if (en) rows = rows.map((r: any) => ({ ...r, topic_name: r.topic_name_en ?? r.topic_name }));
  } else {
    rows = db.prepare(`SELECT * FROM ${meta.table} ORDER BY sort`).all();
    if (en && (req.params.name === 'topics' || req.params.name === 'intents' || req.params.name === 'processes')) {
      rows = rows.map((r: any) => ({ ...r, name: r.name_en ?? r.name }));
    }
  }
  res.json({ items: rows });
});

// POST /api/configs/dicts/:name —— 新增（2026-08-10：只插前端提供字段 + enabled 默认 1，修复"新增不生效"）
configRouter.post('/configs/dicts/:name', requireFn('config_mgmt'), (req, res) => {
  const meta = DICTS[req.params.name];
  if (!meta) return sendErr(req, res, 404, E('DICT_NOT_FOUND', '字典不存在', 'Dictionary not found'));
  const body = req.body ?? {};
  const id = String(body.id || newId());
  const db = getDb();
  const cols: string[] = [meta.idCol];
  const vals: any[] = [id];
  for (const c of meta.editable) {
    if (body[c] !== undefined) { cols.push(c); vals.push(c === 'enabled' ? (body.enabled ? 1 : 0) : body[c] ?? null); }
  }
  if (!cols.includes('enabled')) { cols.push('enabled'); vals.push(1); } // 新增默认启用（不得覆盖为 NULL）
  try {
    db.prepare(`INSERT INTO ${meta.table} (${cols.join(',')}, created_at, updated_at)
      VALUES (${cols.map(() => '?').join(',')}, strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`).run(...vals);
    invalidateConfigCache();
    res.json({ ok: true, id });
  } catch (e: any) {
    sendErr(req, res, 400, E('DICT_ADD_FAILED', `新增失败：${e?.message ?? e}`, `Add failed: ${e?.message ?? e}`));
  }
});

// PUT /api/configs/dicts/:name/:id —— 更新
configRouter.put('/configs/dicts/:name/:id', requireFn('config_mgmt'), (req, res) => {
  const meta = DICTS[req.params.name];
  if (!meta) return sendErr(req, res, 404, E('DICT_NOT_FOUND', '字典不存在', 'Dictionary not found'));
  const body = req.body ?? {};
  const db = getDb();
  const sets = meta.editable.filter((c) => body[c] !== undefined).map((c) => `${c}=?`);
  if (!sets.length) return res.json({ ok: true });
  const vals = meta.editable.filter((c) => body[c] !== undefined).map((c) => body[c] ?? null);
  try {
    db.prepare(`UPDATE ${meta.table} SET ${sets.join(',')}, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE ${meta.idCol}=?`).run(...vals, req.params.id);
    invalidateConfigCache();
    res.json({ ok: true });
  } catch (e: any) {
    sendErr(req, res, 400, E('SAVE_FAILED', `保存失败：${e?.message ?? e}`, `Save failed: ${e?.message ?? e}`));
  }
});

// DELETE /api/configs/dicts/:name/:id —— 物理删除（2026-08-10 起界面不再提供删除入口，改停用；端点保留兼容）
configRouter.delete('/configs/dicts/:name/:id', requireFn('config_mgmt'), (req, res) => {
  const meta = DICTS[req.params.name];
  if (!meta) return sendErr(req, res, 404, E('DICT_NOT_FOUND', '字典不存在', 'Dictionary not found'));
  const db = getDb();
  try {
    db.prepare(`DELETE FROM ${meta.table} WHERE ${meta.idCol}=?`).run(req.params.id);
    invalidateConfigCache();
    res.json({ ok: true });
  } catch (e: any) {
    sendErr(req, res, 400, E('DELETE_FAILED', `删除失败：${e?.message ?? e}`, `Delete failed: ${e?.message ?? e}`));
  }
});
