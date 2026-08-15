// 生成 README 界面截图：主页 / 政策管理 / 安全配置 × 中英 6 张
// 用法：node scripts/screenshots.mjs
// 依赖：puppeteer-core（npm i --no-save puppeteer-core）+ 系统 Chrome/Edge
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'docs', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const executablePath = fs.existsSync(CHROME) ? CHROME : EDGE;
const API = 'http://127.0.0.1:3000';
const BASE = 'https://localhost:5173';
const STORAGE_KEY = 'policybot-session';
const LANG_KEY = 'policybot-lang';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 页面清单：路径 → 文件名
const PAGES = [
  { url: '/', file: 'home' },
  { url: '/admin', file: 'admin' },
  { url: '/console/config/security', file: 'config' },
];
const LANGS = [
  { key: 'zh-CN', suffix: 'zh' },
  { key: 'en-US', suffix: 'en' },
];

async function main() {
  // API 登录拿 token
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ employee_no: 'A001', password: 'Pass1234' }),
  }).then((r) => r.json());
  if (!login.token) { console.error('API 登录失败:', JSON.stringify(login)); process.exit(1); }
  console.log('[1] API 登录成功');

  const browser = await puppeteer.launch({
    executablePath, headless: 'new',
    args: ['--ignore-certificate-errors'],
    defaultViewport: { width: 1440, height: 820 },
    ignoreHTTPSErrors: true,
  });
  const page = await browser.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });

  for (const lang of LANGS) {
    // 注入会话 + 语言
    await page.evaluate((key, token, uid, lkey, lang) => {
      localStorage.setItem(key, JSON.stringify({ sessionId: 'shot-' + Date.now(), timezone: '+08:00', userId: uid, token }));
      localStorage.setItem(lkey, lang);
    }, STORAGE_KEY, login.token, login.user.id, LANG_KEY, lang.key);
    console.log(`[2] ${lang.key} 会话+语言已注入`);

    for (const p of PAGES) {
      await page.goto(`${BASE}${p.url}`, { waitUntil: 'networkidle2' });
      await sleep(3500);
      const info = await page.evaluate(() => ({
        len: document.body.innerText.length,
        head: document.body.innerText.slice(0, 60).replace(/\s+/g, ' '),
      }));
      const file = `${p.file}-${lang.suffix}.png`;
      await page.screenshot({ path: path.join(OUT, file) });
      console.log(`    ${file}（渲染 ${info.len} 字 | ${info.head}）`);
    }
  }

  await browser.close();
  console.log('完成：docs/screenshots/');
}

main().catch((e) => { console.error('截图失败:', e.message); process.exit(1); });
