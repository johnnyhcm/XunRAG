#!/usr/bin/env node
// 探活脚本（S8 稳定性②，2026-08-13）—— 探测 backend/python 存活与假死，失败分级告警
//   与 monitor（资源慢变量）互补：本脚本盯"快故障"（进程退出 / 假死不响应）。
//   假死检测：读 /health 的 JSON 状态（backend/python/deepseek），非只看 HTTP 200（ISSUE #27 WinError 64 进程活着但废）。
//   失败分级：连续 N 次失败 → ①有 NSSM 服务则 nssm restart + 低级别告警；②无 NSSM 则高级别人工告警（不自动杀——杀了没人拉起）。
// 用法：
//   node scripts/health-check.mjs               # 单次探测（schtasks 每 30s 调一次）
//   FAIL_THRESHOLD=3 node scripts/health-check.mjs  # 连续失败阈值（默认 3）
//   MONITOR_WEBHOOK=https://... node scripts/health-check.mjs  # 告警 POST 到 webhook
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(root, 'data', 'logs', 'alerts');
const STATE_FILE = path.join(LOG_DIR, 'health-state.json');
const FAIL_THRESHOLD = Number(process.env.FAIL_THRESHOLD || 3);
const WEBHOOK = process.env.MONITOR_WEBHOOK || '';
const PY_BASE = process.env.PYTHON_BASE_URL || 'http://localhost:8001';
const API = process.env.API_BASE || 'http://localhost:3000/api';
const SERVICES = { backend: 'policybot-backend', python: 'policybot-python' };

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function notify(level, title, message) {
  const line = { time: new Date().toISOString(), level, title, message };
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
  fs.appendFileSync(path.join(LOG_DIR, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`), JSON.stringify(line) + '\n');
  console.log(`  [告警-${level}] ${title}: ${message}`);
  if (WEBHOOK) fetch(WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(line) }).catch(() => {});
}

function nssmManaged(svc) {
  try { execSync(`sc query ${svc}`, { stdio: 'ignore' }); return true; } catch { return false; }
}
function nssmRestart(svc) {
  try { execSync(`nssm restart ${svc}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

// 探测单个服务：返回 { ok, detail }
async function probeBackend() {
  try {
    const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    // 假死检测：HTTP 200 但状态内容异常也判失败
    return { ok: r.ok && j?.status === 'ok' && j?.backend === 'up', detail: JSON.stringify(j ?? {}) };
  } catch { return { ok: false, detail: 'unreachable' }; }
}
async function probePython() {
  try {
    const r = await fetch(`${PY_BASE}/health`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return { ok: r.ok && j?.status === 'ok', detail: JSON.stringify(j ?? {}) };
  } catch { return { ok: false, detail: 'unreachable' }; }
}

async function main() {
  const state = loadState();
  const probes = { backend: await probeBackend(), python: await probePython() };
  let dirty = false;

  for (const [name, svc] of Object.entries(SERVICES)) {
    const p = probes[name];
    const st = state[name] ?? { fails: 0, alerted: false, restarts: 0 };
    console.log(`[health-check] ${name}: ${p.ok ? '✅ up' : '❌ DOWN'}（${p.detail.slice(0, 80)}）`);

    if (p.ok) {
      if (st.fails > 0 || st.alerted) {
        notify('info', `${name} 已恢复`, `连续失败 ${st.fails} 次后恢复`);
        dirty = true;
      }
      st.fails = 0; st.alerted = false; st.restarts = 0;
    } else {
      st.fails++;
      dirty = true;
      if (st.fails >= FAIL_THRESHOLD) {
        if (nssmManaged(svc)) {
          // 有 NSSM：自动重启 + 低级别告警
          const restarted = nssmRestart(svc);
          st.restarts++;
          if (!st.alerted) {
            notify(restarted ? 'warn' : 'critical', `${name} 连续 ${st.fails} 次探测失败${restarted ? '，已自动重启' : '，重启失败'}`, `${name} 详情：${p.detail.slice(0, 120)}`);
            st.alerted = true;
          } else if (st.restarts >= 3) {
            notify('critical', `${name} 连续 ${st.restarts} 次重启仍失败，请人工介入`, `${name} 详情：${p.detail.slice(0, 120)}`);
            st.restarts = 0; // 重置，避免每次探测都刷屏
          }
        } else {
          // 无 NSSM：不自动杀（杀了没人拉起），只高级别人工告警一次
          if (!st.alerted) {
            notify('critical', `${name} 连续 ${st.fails} 次探测失败（无守护进程，需手动重启）`, `${name} 详情：${p.detail.slice(0, 120)}`);
            st.alerted = true;
          }
        }
      }
    }
    state[name] = st;
  }

  if (dirty) saveState(state);
}

main().catch((e) => { console.error(`[health-check] ❌ 失败：${e?.message ?? e}`); process.exit(1); });
