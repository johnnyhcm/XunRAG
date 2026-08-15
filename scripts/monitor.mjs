#!/usr/bin/env node
// 资源监控脚本（S8 稳定性④，2026-08-13）—— 采集磁盘/内存 + 服务健康状态，阈值告警
//   职责：盯"慢变量"（磁盘一天天涨满 / 内存泄漏 / 服务状态变化），与 health-check（快故障探测）互补。
//   告警：写告警日志（data/logs/alerts/）+ 可选 webhook（MONITOR_WEBHOOK 环境变量）；状态变化才告警（去重，防刷屏）。
// 用法：
//   node scripts/monitor.mjs                 # 单次采集 + 阈值判断 + 告警
//   DISK_THRESHOLD=80 MEM_THRESHOLD=90 node scripts/monitor.mjs   # 自定义阈值（百分比）
//   MONITOR_WEBHOOK=https://... node scripts/monitor.mjs          # 告警 POST 到 webhook
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(root, 'data', 'logs', 'alerts');
const STATE_FILE = path.join(LOG_DIR, 'state.json');
const DISK_THRESHOLD = Number(process.env.DISK_THRESHOLD || 80);
const MEM_THRESHOLD = Number(process.env.MEM_THRESHOLD || 90);
const WEBHOOK = process.env.MONITOR_WEBHOOK || '';
const PY_BASE = process.env.PYTHON_BASE_URL || 'http://localhost:8001';
const API = process.env.API_BASE || 'http://localhost:3000/api';

// ---- 采集 ----
function collectDisk() {
  // PowerShell 纯数字输出（避免中文编码问题）：每盘 Name UsedGB FreeGB
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Where-Object {$_.Used -ne $null} | ForEach-Object { Write-Output ($_.Name + ',' + [math]::Round($_.Used/1GB,1) + ',' + [math]::Round($_.Free/1GB,1)) }"`,
      { encoding: 'utf8', windowsHide: true },
    );
    const disks = [];
    for (const line of out.split('\n')) {
      const parts = line.trim().split(',');
      if (parts.length === 3 && parts[1] !== '') {
        const [name, used, free] = parts;
        const usedG = parseFloat(used), freeG = parseFloat(free);
        disks.push({ name, usedGb: usedG, freeGb: freeG, usedPct: Math.round((usedG / (usedG + freeG)) * 100) });
      }
    }
    return disks;
  } catch (e) { return null; }
}

function collectMem() {
  const total = os.totalmem(), free = os.freemem();
  return { usedGb: +((total - free) / 1e9).toFixed(1), totalGb: +(total / 1e9).toFixed(1), usedPct: Math.round(((total - free) / total) * 100) };
}

async function collectHealth() {
  const health = { backend: false, python: false, deepseek: 'unknown' };
  try {
    const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    health.backend = j?.status === 'ok' && j?.backend === 'up';
    health.python = j?.python === 'up';
    health.deepseek = j?.deepseek ?? 'unknown';
  } catch { health.backend = false; }
  try {
    const r = await fetch(`${PY_BASE}/health`, { signal: AbortSignal.timeout(5000) });
    health.python = health.python || r.ok;
  } catch { /* 保持 false */ }
  return health;
}

// ---- 告警状态机（去重：状态变化才告警） ----
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function alert(level, title, message) {
  const line = { time: new Date().toISOString(), level, title, message };
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
  const logFile = path.join(LOG_DIR, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`);
  fs.appendFileSync(logFile, JSON.stringify(line) + '\n');
  console.log(`  [告警-${level}] ${title}: ${message}`);
  if (WEBHOOK) {
    fetch(WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(line) })
      .catch(() => { /* webhook 失败不阻塞 */ });
  }
}

function transition(state, key, ok, level, title, message) {
  const prev = state[key] ?? 'ok';
  const now = ok ? 'ok' : 'alarm';
  if (prev !== now) {
    if (!ok) alert(level, title, message);
    else alert('info', title + ' 已恢复', message);
    state[key] = now;
  }
  return now;
}

// ---- 主流程 ----
async function main() {
  const state = loadState();
  let changed = false;
  console.log(`[monitor] ${new Date().toISOString()} 采集：`);

  // 磁盘
  const disks = collectDisk();
  if (!disks) { console.log('  磁盘：采集失败'); }
  else {
    for (const d of disks) {
      const flag = d.usedPct > DISK_THRESHOLD ? '⚠️' : '✅';
      console.log(`  磁盘 ${d.name}: ${d.usedPct}% 已用（${d.usedGb}GB/${(d.usedGb + d.freeGb).toFixed(0)}GB）${flag}`);
      const nw = transition(state, `disk:${d.name}`, d.usedPct <= DISK_THRESHOLD, 'warn', `磁盘 ${d.name} 使用率 ${d.usedPct}% 超阈值 ${DISK_THRESHOLD}%`, `${d.name} 盘剩余 ${d.freeGb}GB`);
      if (nw === 'alarm' || nw === 'ok') changed = true;
    }
  }

  // 内存
  const mem = collectMem();
  const memFlag = mem.usedPct > MEM_THRESHOLD ? '⚠️' : '✅';
  console.log(`  内存: ${mem.usedPct}% 已用（${mem.usedGb}GB/${mem.totalGb}GB）${memFlag}`);
  const mn = transition(state, 'memory', mem.usedPct <= MEM_THRESHOLD, 'warn', `内存使用率 ${mem.usedPct}% 超阈值 ${MEM_THRESHOLD}%`, `已用 ${mem.usedGb}GB / 共 ${mem.totalGb}GB`);
  if (mn === 'alarm' || mn === 'ok') changed = true;

  // 服务健康（只记录告警，重启动作归 health-check）
  const h = await collectHealth();
  console.log(`  服务: backend=${h.backend ? 'up' : 'DOWN'} python=${h.python ? 'up' : 'DOWN'} deepseek=${h.deepseek}`);
  const hn = transition(state, 'service', h.backend && h.python, 'critical', `服务不可用（backend=${h.backend} python=${h.python}）`, '请检查 backend(3000) 与 python(8001) 进程');
  if (hn === 'alarm' || hn === 'ok') changed = true;

  if (changed) saveState(state);
}

main().catch((e) => { console.error(`[monitor] ❌ 失败：${e?.message ?? e}`); process.exit(1); });
