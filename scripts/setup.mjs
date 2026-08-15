#!/usr/bin/env node
/**
 * XunRAG 一键初始化脚本（npm run setup）—— 从零到"可登录使用"
 *
 * 流程（全部自动，幂等）：
 *   [0] 横幅
 *   [1] 环境检查   Node ≥22 / Python ≥3.12 / pandoc ≥3.0（不满足 → 明确报错退出）
 *   [2] 依赖检查   node_modules / Python 关键包（缺失 → 提示安装命令，不自动装）
 *   [3] 模型检查   检索模型（bge-m3/bge-reranker）缺失 → 交互询问自动下载（约 6.5GB）
 *   [4] 启动检索引擎 Python（8001，detached 后台 + 日志）
 *   [5] 数据初始化  admin / 配置 / 用户组 / 字典 / 《操作手册》入库 / 向量化（复用 init 逻辑）
 *   [6] 启动服务    backend（3000）+ frontend（5173，detached 后台 + 日志）
 *   [7] 总结输出    访问地址 / 登录账号 / 唯一手动步骤（配大模型 Key）/ 生产部署提醒
 *
 * 用法：
 *   npm run setup                 # 完整一键（模型缺失时交互询问）
 *   npm run setup -- --skip-models  # 跳过模型下载询问（高效模式不可用，非交互环境用）
 *
 * 环境（可选覆盖，测试隔离用）：
 *   SQLITE_PATH / POLICYBOT_CHROMA_PATH / PYTHON_PORT / PORT / VITE_PORT
 * 安全：不写入任何密钥；不注册系统服务（生产 NSSM 部署见 README/管理员手册）
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const LOG_DIR = path.join(root, 'data', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

// 端口（可用 env 覆盖，测试隔离）
const PYTHON_PORT = Number(process.env.PYTHON_PORT || 8001);
const BACKEND_PORT = Number(process.env.PORT || 3000);
const FRONTEND_PORT = Number(process.env.VITE_PORT || 5173);

const PYTHON_BASE = `http://127.0.0.1:${PYTHON_PORT}`;
const BACKEND_BASE = `http://127.0.0.1:${BACKEND_PORT}`;

const TSX_CLI = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const VITE_CLI = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const PYTHON_BIN = process.env.POLICYBOT_PYTHON || 'python';

function log(tag, msg) { console.log(`[setup] ${tag} ${msg}`); }

/** 端口是否已监听 */
function isPortOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}

/** 轮询等待某 URL 返回 OK */
async function waitHttp(url, label, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) { log('wait', `${label} 就绪`); return true; }
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  log('warn', `⚠️ ${label} 等待超时（${timeoutMs}ms）——请检查日志 ${LOG_DIR}`);
  return false;
}

/** detached 后台启动进程（日志重定向，不随终端退出） */
function startDetached(cmd, args, cwd, logFile) {
  const fd = fs.openSync(path.join(LOG_DIR, logFile), 'a');
  const child = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  return child;
}

// ---------- [1] 环境检查 ----------
function checkEnv() {
  console.log('\n[1/7] 环境检查 ...');
  const fail = [];
  // Node
  try {
    const v = spawnSync('node', ['--version'], { encoding: 'utf-8' }).stdout.trim();
    const m = /^v(\d+)/.exec(v);
    if (!m || Number(m[1]) < 22) fail.push(`Node.js ≥22 需要（当前 ${v || '未知'}）`);
    else log('env', `Node.js ${v} ✓`);
  } catch { fail.push('未找到 Node.js（需要 ≥22）'); }
  // Python
  try {
    const v = spawnSync(PYTHON_BIN, ['--version'], { encoding: 'utf-8' }).stderr.trim() || spawnSync(PYTHON_BIN, ['--version'], { encoding: 'utf-8' }).stdout.trim();
    const m = /(\d+)\.(\d+)/.exec(v);
    if (!m || Number(m[1]) < 3 || (Number(m[1]) === 3 && Number(m[2]) < 12)) fail.push(`Python ≥3.12 需要（当前 ${v || '未知'}）`);
    else log('env', `${v} ✓`);
  } catch { fail.push('未找到 Python（需要 ≥3.12）'); }
  // pandoc
  try {
    const v = spawnSync(PYTHON_BIN, ['-c', 'import pypandoc; print(pypandoc.get_pandoc_version())'], { encoding: 'utf-8' }).stdout.trim();
    const m = /(\d+)\.(\d+)/.exec(v);
    if (!m || Number(m[1]) < 3) fail.push(`pandoc ≥3.0 需要（当前 ${v || '未安装'}，pip install pypandoc 可自动带）`);
    else log('env', `pandoc ${v} ✓`);
  } catch { fail.push('pandoc 不可用（pip install pypandoc）'); }
  if (fail.length) {
    console.error('\n❌ 环境不满足：');
    for (const f of fail) console.error(`   - ${f}`);
    console.error('\n请先安装依赖后重跑 npm run setup。');
    process.exit(1);
  }
}

// ---------- [2] 依赖检查 ----------
function checkDeps() {
  console.log('\n[2/7] 依赖检查 ...');
  let ok = true;
  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    console.error('  ❌ node_modules 缺失——请先执行 npm install 后重跑 npm run setup');
    ok = false;
  } else log('dep', 'Node 依赖就绪 ✓');
  try {
    const r = spawnSync(PYTHON_BIN, ['-c', 'import fastapi, sentence_transformers, chromadb, pypandoc'], { encoding: 'utf-8' });
    if (r.status !== 0) {
      console.error('  ❌ Python 依赖缺失——请先执行 pip install -r requirements.txt 后重跑 npm run setup');
      ok = false;
    } else log('dep', 'Python 依赖就绪 ✓');
  } catch { ok = false; }
  if (!ok) process.exit(1);
}

// ---------- [3] 模型检查 + 交互下载 ----------
async function ensureModels(skipDownload) {
  console.log('\n[3/7] 检索模型检查 ...');
  const { checkModels } = await import('./init.mjs');
  const modelsOk = checkModels();
  if (modelsOk) { log('model', '检索模型已就绪（bge-m3 + bge-reranker-v2-m3）✓'); return true; }
  if (skipDownload) {
    console.warn('  ⚠️ 跳过模型下载（--skip-models）：高效模式将不可用。可稍后运行 python tools/download_models.py');
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question('  检索模型缺失（bge-m3 + bge-reranker，约 6.5GB）。立即自动下载？[Y/n] ')).trim().toLowerCase();
  rl.close();
  if (ans === 'n') {
    console.warn('  ⚠️ 跳过模型下载：高效模式将不可用（向量化失败）。可稍后运行 python tools/download_models.py');
    return false;
  }
  console.log('  开始下载（ModelScope）...');
  const r = spawnSync(PYTHON_BIN, [path.join('tools', 'download_models.py')], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) { console.error('  ❌ 模型下载失败，请手动运行 python tools/download_models.py'); process.exit(1); }
  return checkModels();
}

// ---------- [4] 启动检索引擎 ----------
async function startPython() {
  console.log('\n[4/7] 检索引擎（Python）...');
  if (await isPortOpen(PYTHON_PORT)) { log('py', `端口 ${PYTHON_PORT} 已有服务，复用 ✓`); return true; }
  const env = { ...process.env, PYTHON_PORT: String(PYTHON_PORT) };
  const child = spawn(PYTHON_BIN, ['app/python/server.py'], { cwd: root, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  // 日志重定向（pipe → 文件）
  const out = fs.createWriteStream(path.join(LOG_DIR, 'setup-python.log'), { flags: 'a' });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.unref();
  log('py', `已启动（${LOG_DIR}/setup-python.log），等待就绪...`);
  return waitHttp(`${PYTHON_BASE}/health`, 'Python');
}

// ---------- [5] 数据初始化 ----------
async function seedAll() {
  console.log('\n[5/7] 数据初始化 ...');
  const init = await import('./init.mjs');
  const { require_ts } = init;
  const { getDb } = require_ts(path.join(root, 'app', 'backend', 'src', 'db', 'index.ts'));
  const { newId } = require_ts(path.join(root, 'app', 'backend', 'src', 'db', 'repo.ts'));
  const db = getDb();
  const dbPath = db.name;
  init.seedUsers(db, newId);
  init.seedConfig(db, dbPath);
  init.seedGroups(db);
  init.seedManual(db, newId);
  await init.indexManual(db, newId);
}

// ---------- [6] 启动服务 ----------
async function startWeb() {
  console.log('\n[6/7] Web 服务（backend + frontend）...');
  // backend（tsx watch，dev 模式）
  if (await isPortOpen(BACKEND_PORT)) {
    log('backend', `端口 ${BACKEND_PORT} 已有服务，复用 ✓`);
  } else if (!fs.existsSync(TSX_CLI)) {
    console.error(`  ❌ tsx 未安装（${TSX_CLI}）——请先 npm install`);
    process.exit(1);
  } else {
    const env = { ...process.env, PORT: String(BACKEND_PORT), PYTHON_BASE_URL: PYTHON_BASE };
    const child = spawn(process.execPath, [TSX_CLI, 'watch', 'app/backend/src/main.ts'], { cwd: root, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(path.join(LOG_DIR, 'setup-backend.log'), { flags: 'a' });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.unref();
    log('backend', `已启动（${LOG_DIR}/setup-backend.log），等待就绪...`);
  }
  await waitHttp(`${BACKEND_BASE}/api/health`, 'backend');

  // frontend（vite）
  if (await isPortOpen(FRONTEND_PORT)) {
    log('frontend', `端口 ${FRONTEND_PORT} 已有服务，复用 ✓`);
  } else if (!fs.existsSync(VITE_CLI)) {
    console.error(`  ❌ vite 未安装（${VITE_CLI}）——请先 npm install`);
    process.exit(1);
  } else {
    const env = { ...process.env, VITE_PORT: String(FRONTEND_PORT), BACKEND_PORT: String(BACKEND_PORT) };
    const child = spawn(process.execPath, [VITE_CLI], { cwd: path.join(root, 'app', 'frontend'), detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(path.join(LOG_DIR, 'setup-frontend.log'), { flags: 'a' });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.unref();
    log('frontend', `已启动（${LOG_DIR}/setup-frontend.log），等待就绪...`);
  }
  // vite 为 HTTPS（自签证书），waitHttp 的 http 探测不适用——用端口监听轮询
  const t0 = Date.now();
  while (!(await isPortOpen(FRONTEND_PORT))) {
    if (Date.now() - t0 > 40000) { log('warn', `⚠️ frontend 等待超时——检查 ${LOG_DIR}/setup-frontend.log`); break; }
    await new Promise((r) => setTimeout(r, 800));
  }
  if (await isPortOpen(FRONTEND_PORT)) log('frontend', '就绪 ✓');
}

// ---------- [7] 总结 ----------
function printSummary() {
  console.log('\n[7/7] 完成');
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  ✅ XunRAG 已就绪！');
  console.log('');
  console.log('  访问：https://localhost:' + FRONTEND_PORT + '（https！自签证书点「继续前往」）');
  console.log('  登录：工号 A001 / 初始密码 Pass1234（首登强制改密）');
  console.log('');
  console.log('  唯一手动步骤：配置大模型（不配无法问答）');
  console.log('    登录后 → 系统配置 → 模型接入 →');
  console.log('    云端 API：DeepSeek 等 → 粘贴 API Key → 刷新模型 → 选择模型');
  console.log('    或 本地模型：下载 GGUF 放入 models/llm/ → 模型接入页选择');
  console.log('');
  console.log('  已就绪：admin / 60 项配置 / 「系统帮助」库（操作手册已入库，可问"什么是 XunRAG"）');
  console.log('  服务日志：data/logs/setup-*.log');
  console.log('');
  console.log('  ⚠️ 快速开始为开发模式（无进程守护、无自动备份）。');
  console.log('    正式使用：npm run build + install-services.ps1 + register-schedules.ps1（见 README）');
  console.log('══════════════════════════════════════════════════════════════');
}

// ---------- 主流程 ----------
async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   XunRAG 一键初始化（npm run setup）          ║');
  console.log('╚══════════════════════════════════════════════╝');
  const skipModels = process.argv.includes('--skip-models');
  checkEnv();          // [1]
  checkDeps();         // [2]
  await ensureModels(skipModels); // [3]
  await startPython(); // [4]
  await seedAll();     // [5]
  await startWeb();    // [6]
  printSummary();      // [7]
  process.exit(0);
}

main().catch((e) => { console.error('[setup] 失败：', e); process.exit(1); });
