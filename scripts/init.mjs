#!/usr/bin/env node
/**
 * XunRAG 开源首次初始化脚本（幂等，可重复执行）
 *
 * 功能：
 *   Phase A  种子数据：admin 账号 / 配置（出厂默认 + 用户自定义 seed-config.json 覆盖）
 *             / 业务主题 / 意图 / 流程 / 对接人路由 / 联系人用户 / 内置用户组
 *   Phase B  导入《管理员手册》（docs/ADMIN_GUIDE.zh-CN.md + ADMIN_GUIDE.md）
 *            到「系统帮助」政策库：建库 → 建线 → 建版本 → 按标题切片 → 写入 chunks
 *   Phase C  向量化：检测 Python 检索引擎，在线则入库（ingestVersion），
 *            未启动则提示先启动后再重跑（幂等，已完成项自动跳过）
 *   Phase D  引导：提示配置 API Key / 本地模型、初始账号、启动方式
 *
 * 用法：
 *   npm run init                      # 初始化正式库（默认 data/policybot.db）
 *   SQLITE_PATH=/tmp/test.db npm run init   # 初始化到指定库（测试隔离）
 *
 * 安全：本脚本不写入任何密钥；配置种子（scripts/seed/seed-config.json）不含
 *       API Key / 加密密钥（密钥在 llm_config 与 ~/.policybot-secrets/）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';


// ---------- 路径 ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ---------- 用 tsx 加载后端 TS 服务（复用切片/入库逻辑，保证与业务一致）----------
import { createRequire } from 'node:module';
// tsx 通过 npm run init 提供（见 package.json scripts.init），此处显式校验
const backendSrc = (p) => path.join(root, 'app', 'backend', 'src', p);

// ---------- 常量 ----------
const LIBRARY_NAME = '系统帮助';
const MANUAL_ZH = { file: path.join(root, 'docs', 'ADMIN_GUIDE.zh-CN.md'), lineName: 'XunRAG 管理员手册（中文）', versionNo: '1.0', lang: '["zh"]' };
const MANUAL_EN = { file: path.join(root, 'docs', 'ADMIN_GUIDE.md'), lineName: 'XunRAG Administrator Guide (English)', versionNo: '1.0', lang: '["en"]' };

// ---------- 工具 ----------
function log(tag, msg) { console.log(`[init] ${tag} ${msg}`); }

/** Phase 0：检索模型检测（bge-m3 / bge-reranker 未下载 → 醒目提示；不阻断但向量化会失败） */
export function checkModels() {
  const needed = [
    ['bge-m3 向量模型', path.join(root, 'models', 'embedding', 'bge-m3', 'config.json')],
    ['bge-reranker 精排模型', path.join(root, 'models', 'reranker', 'bge-reranker-v2-m3', 'config.json')],
  ];
  const missing = needed.filter(([, p]) => !fs.existsSync(p));
  if (missing.length) {
    console.log('');
    console.log('⚠️  ⚠️  缺少检索模型（高效模式将不可用，向量化会失败）：');
    for (const [name] of missing) console.log(`    - ${name}`);
    console.log('  请先下载（约 6.5GB）：');
    console.log('    python tools/download_models.py                       # ModelScope（国内快）');
    console.log('    python tools/download_models.py --source huggingface  # HuggingFace');
    console.log('');
    return false;
  }
  log('model', '检索模型就绪（bge-m3 + bge-reranker-v2-m3）');
  return true;
}

function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(text);
}

/** Markdown → 简单 HTML（供阅读页渲染；只处理手册用到的元素：标题/段落/表格/列表/代码/引用/粗体） */
function mdToHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const lines = md.split('\n');
  const out = [];
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { if (inTable) { out.push('</table>'); inTable = false; } out.push(''); continue; }
    // 表格：连续 | 行
    if (t.startsWith('|')) {
      if (!inTable) { out.push('<table>'); inTable = true; }
      const cells = t.split('|').filter((c, idx, arr) => !(idx === 0 || idx === arr.length - 1) || c.trim()).map((c) => c.trim());
      const isHeader = /^[\s:|-]+$/.test(cells.join('')) || out[out.length - 1] === '<table>' || (out[out.length - 2] === '<table>');
      // 分隔行（| --- | --- |）跳过
      if (/^[\s:|-]+$/.test(t.replace(/\|/g, ''))) continue;
      if (out[out.length - 1] === '<table>' || out[out.length - 1] === '<tr>') {
        out.push(`<tr>${cells.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>`);
        continue;
      }
      out.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      continue;
    }
    if (inTable) { out.push('</table>'); inTable = false; }
    if (/^#{1,3}\s+/.test(t)) {
      const level = t.match(/^(#+)/)[1].length;
      out.push(`<h${level}>${inline(t.replace(/^#+\s*/, ''))}</h${level}>`);
    } else if (/^>\s?/.test(t)) {
      out.push(`<blockquote>${inline(t.replace(/^>\s?/, ''))}</blockquote>`);
    } else if (/^[-*]\s+/.test(t) && !/^\|/.test(t)) {
      out.push(`<li>${inline(t.replace(/^[-*]\s+/, ''))}</li>`);
    } else if (/^\d+\.\s+/.test(t)) {
      out.push(`<li>${inline(t.replace(/^\d+\.\s+/, ''))}</li>`);
    } else {
      out.push(`<p>${inline(t)}</p>`);
    }
  }
  if (inTable) out.push('</table>');
  return `<body>${out.join('\n')}</body>`;
}

/** 按空行分段 → ConvertSegment 列表（供 sliceByRule 复用） */
function mdToSegments(md) {
  return md
    .split(/\n\s*\n/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, i) => ({ index: i, text, lang: hasChinese(text) ? 'zh' : 'en', type: 'body' }));
}

// ---------- Phase A：种子数据 ----------
export function seedUsers(db, newId) {
  // admin 账号（不存在才建；已存在不重置密码——尊重已有数据）
  const exists = db.prepare("SELECT id FROM users WHERE id='admin'").get();
  if (exists) { log('user', 'admin 已存在，跳过'); return; }
  // 密码哈希：与 password.ts 一致（scrypt$salt$hash，salt 16B, hash 64B）
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync('Pass1234', salt, 64).toString('hex');
  db.prepare(`INSERT INTO users
    (id, employee_no, name, role, status, must_change_password, password_hash, timezone, language, created_at, updated_at)
    VALUES ('admin', 'A001', '系统管理员', 'admin', 'active', 1, ?, '+08:00', 'zh-CN',
            strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
    .run(`scrypt$${salt}$${hash}`);
  log('user', '已创建 admin（A001 / Pass1234 / 首登强制改密）');
}


export function seedConfig(db, dbPath) {
  // 1) 业务字典种子（主题/意图/流程/路由/联系人用户 + 基础配置）：migrate-config.mjs（argv[2] 指定库）
  const r = spawnSync(process.execPath, [path.join(__dirname, 'migrate-config.mjs'), dbPath],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf-8' });
  if (r.status !== 0) { log('config', 'migrate-config.mjs 执行失败（非致命，继续）'); }
  else log('config', '业务字典种子就绪（主题/意图/流程/路由/联系人）');

  // 2) 密级字典（field_dicts.security_level + 默认档位）：migrate-security.mjs（SQLITE_PATH env）
  const r2 = spawnSync(process.execPath, [path.join(__dirname, 'migrate-security.mjs')],
    { cwd: root, env: { ...process.env, SQLITE_PATH: dbPath }, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf-8' });
  if (r2.status !== 0) { log('config', 'migrate-security.mjs 执行失败（非致命，继续）'); }

  // 3) 配置表完整种子：seed-config.json（60 条，含结构字段 + 开源作者预设 value/value_en）
  //    UPSERT：行不存在则创建（含界面保存类 key 如 security.levels），存在则更新用户值；不含密钥
  const seedFile = path.join(__dirname, 'seed', 'seed-config.json');
  if (!fs.existsSync(seedFile)) { log('config', '未找到 seed-config.json，跳过配置种子'); return; }
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));
  const upsert = db.prepare(`INSERT INTO app_configs
    (key, module, section, label, type, value, default_value, value_en, variables, options,
     description, description_en, i18n, hidden, sort, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(key) DO UPDATE SET
      value=excluded.value, value_en=excluded.value_en, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
  let n = 0;
  for (const [key, c] of Object.entries(seed)) {
    upsert.run(key, c.module ?? 'common', c.section ?? 'seed', c.label ?? key, c.type ?? 'text',
      c.value ?? null, c.default_value ?? '', c.value_en ?? null, c.variables ?? null,
      c.options ?? null, c.description ?? null, c.description_en ?? null,
      c.i18n ?? 0, c.hidden ?? 0, c.sort ?? 0);
    n++;
  }
  log('config', `配置表种子就绪：${n} 条（含预设用户值，不含密钥）`);
}

export function seedGroups(db) {
  // 内置用户组（schema 不种，这里幂等补）——与 migrate-permission 语义一致
  db.prepare(`INSERT OR IGNORE INTO user_groups
    (id, name, type, description, enabled, sort, function_ids, managed_library_ids)
    VALUES ('system_admin', '系统管理员组', 'builtin', '全部功能 + 全部政策库', 1, 0, '["policy_mgmt","user_mgmt","role_mgmt","config_mgmt","stats_view","policy_library_mgmt"]', '["ALL"]')`).run();
  db.prepare(`INSERT OR IGNORE INTO user_groups
    (id, name, type, description, enabled, sort, function_ids, managed_library_ids)
    VALUES ('employee', '员工组', 'builtin', '全员默认：仅查询', 1, 99, '["query"]', NULL)`).run();
  // admin 加入系统管理员组（幂等）
  db.prepare(`INSERT OR IGNORE INTO user_group_members (group_id, user_id, type, created_at)
    VALUES ('system_admin', 'admin', 'include', strftime('%Y-%m-%dT%H:%M:%SZ','now'))`).run();
  log('group', '内置用户组就绪（system_admin / employee）');
}

// ---------- Phase B：导入手册到「系统帮助」库 ----------
export function seedManual(db, newId) {
  const lib = db.prepare('SELECT id FROM policy_libraries WHERE name=?').get(LIBRARY_NAME);
  let libraryId;
  if (lib) {
    libraryId = lib.id;
    log('manual', `政策库「${LIBRARY_NAME}」已存在，复用`);
  } else {
    libraryId = newId();
    db.prepare(`INSERT INTO policy_libraries
      (id, name, description, status, default_visibility, admin_ids, created_by, created_at, updated_at)
      VALUES (?, ?, '系统内置帮助文档库（XunRAG 初始化生成）', 'active', NULL, '[]', 'admin',
              strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
      .run(libraryId, LIBRARY_NAME);
    log('manual', `创建政策库「${LIBRARY_NAME}」`);
  }

  for (const m of [MANUAL_ZH, MANUAL_EN]) {
    if (!fs.existsSync(m.file)) { log('manual', `跳过（文件不存在）: ${m.file}`); continue; }
    // 幂等：同名政策线已存在则跳过
    const dup = db.prepare('SELECT id FROM policy_lines WHERE name=?').get(m.lineName);
    if (dup) { log('manual', `「${m.lineName}」已存在，跳过`); continue; }

    const md = fs.readFileSync(m.file, 'utf-8');
    const lineId = newId();
    const versionId = newId();
    const today = new Date().toISOString().slice(0, 10);

    // 政策线
    db.prepare(`INSERT INTO policy_lines
      (id, library_id, name, policy_type, topic, security_level, publish_org, tags,
       created_by, created_at, updated_at)
      VALUES (?, ?, ?, '手册', 'other', 'public', 'XunRAG', '[]', 'admin',
              strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
      .run(lineId, libraryId, m.lineName);

    // 版本（已发布，今天生效）
    db.prepare(`INSERT INTO policy_versions
      (id, line_id, version_no, status, language, effective_from, effective_to, change_note,
       original_file_name, markdown_content, html_content, convert_status, convert_quality,
       slice_plan, index_status, published_by, published_at, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'published', ?, ?, NULL, '初始导入（init 脚本）', ?, ?, ?, 'confirmed', 'ok',
              NULL, 'pending', 'admin', strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'admin',
              strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))`)
      .run(versionId, lineId, m.versionNo, m.lang, today, path.basename(m.file), md, mdToHtml(md));

    // 切片：md → segments → sliceByRule + aggregateChunks（与业务同源）
    const { sliceByRule, aggregateChunks, chunkAnchor, estimateTokens } = require_ts(backendSrc('services/slice.ts'));
    const segments = mdToSegments(md);
    const plan = sliceByRule(segments);
    const chunks = aggregateChunks(plan);
    const insChunk = db.prepare(`INSERT INTO policy_chunks
      (id, version_id, chunk_index, content, retained, level, has_table, section_path, anchor, token_count, type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`);
    const ids = [];
    for (const c of chunks) {
      const id = newId();
      ids.push(id);
      insChunk.run(id, versionId, c.chunk_index, c.content, c.retained ? 1 : 0,
        c.level, c.has_table ? 1 : 0, c.section_path, chunkAnchor(c.section_path),
        estimateTokens(c.content), c.type);
    }
    // 相邻指针（阅读页上下文用）
    for (let i = 0; i < ids.length; i++) {
      db.prepare(`UPDATE policy_chunks SET adjacent_prev_id=?, adjacent_next_id=?
        WHERE id=?`).run(ids[i - 1] ?? null, ids[i + 1] ?? null, ids[i]);
    }
    log('manual', `「${m.lineName}」入库：${chunks.length} 切片（retained ${chunks.filter((c) => c.retained).length}）`);
  }
}

export function require_ts(p) {
  return createRequire(import.meta.url)(p);
}

// ---------- Phase C：向量化 ----------
export async function indexManual(db, newId) {
  const versions = db.prepare(`SELECT v.id, v.line_id FROM policy_versions v
    JOIN policy_lines pl ON pl.id=v.line_id
    WHERE v.index_status != 'indexed' AND v.status='published'`).all();
  if (!versions.length) { log('index', '无待入库版本（全部已 indexed）'); return; }

  // 检测 Python 检索引擎
  const pyOk = await fetch('http://localhost:8001/health', { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok).catch(() => false);
  if (!pyOk) {
    log('index', '⚠️ 未检测到 Python 检索引擎（localhost:8001）——数据已入库，向量化待 Python 启动后重跑');
    log('index', '   请先启动：python app/python/server.py ，然后重新执行 npm run init');
    return;
  }
  const { ingestVersion } = require_ts(backendSrc('services/ingest.ts'));
  for (const v of versions) {
    try {
      const r = await ingestVersion(v.line_id, v.id);
      log('index', `版本 ${v.id.slice(0, 8)} 向量化完成（${r.indexed} 切片）`);
    } catch (e) {
      log('index', `⚠️ 版本 ${v.id.slice(0, 8)} 向量化失败：${e.message}`);
    }
  }
}

// ---------- Phase D：引导 ----------
function printGuide(pyOk) {
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  ✅ XunRAG 初始化完成！接下来：');
  console.log('');
  console.log('  【第 1 步】配置大模型（必须，否则无法问答）');
  console.log('    方式一（推荐·最快）：登录后 → 系统配置 → 模型接入 →');
  console.log('      云端 API → DeepSeek（或其他）→ 粘贴 API Key → 刷新模型 → 选择模型');
  console.log('    方式二（数据不出内网）：下载本地模型（如千问 GGUF）→');
  console.log('      模型接入 → 本地模型 → 选择模型文件');
  console.log('      （模型下载：python tools/download_models.py 可下载检索模型；');
  console.log('       本地 LLM 自行下载 GGUF 放入 models/llm/）');
  console.log('');
  console.log('  【第 2 步】启动服务');
  console.log('    终端 1：python app/python/server.py');
  console.log('    终端 2：npm run dev');
  console.log('');
  console.log('  【第 3 步】登录');
  console.log('    访问 https://localhost:5173（https！自签证书点「继续前往」）');
  console.log('    工号 A001 / 初始密码 Pass1234（首登强制改密）');
  console.log('');
  console.log('  【已就绪的内容】');
  console.log('    - 政策库「系统帮助」：已导入《管理员手册》（中英）');
  console.log('      → 可提问"什么是 XunRAG""怎么配置模型"等');
  console.log('    - 配置：出厂默认 + 开源作者预设（seed-config.json）');
  if (!pyOk) {
    console.log('');
    console.log('  ⚠️ 向量化未执行（Python 未启动）：启动 Python 后重跑 npm run init');
  }
  console.log('══════════════════════════════════════════════════════════════');
}

// ---------- 主流程 ----------
async function main() {
  log('start', 'XunRAG 初始化开始');
  checkModels();
  const { getDb } = require_ts(backendSrc('db/index.ts'));
  const { newId } = require_ts(backendSrc('db/repo.ts'));
  const db = getDb();
  const dbPath = db.name; // better-sqlite3 库路径（传给 migrate-config.mjs 作 argv[2]）

  seedUsers(db, newId);
  seedConfig(db, dbPath);
  seedGroups(db);
  seedManual(db, newId);

  // Phase C：检测 Python（供引导输出使用）
  const pyOk = await fetch('http://localhost:8001/health', { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok).catch(() => false);
  await indexManual(db, newId);

  printGuide(pyOk);
  log('done', '初始化完成（幂等，可重复执行）');
  process.exit(0);
}

// CLI 守卫：仅直接运行时执行 main()（作为模块被 setup.mjs import 时不执行）
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[init] 失败：', e); process.exit(1); });
}
