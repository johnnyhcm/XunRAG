#!/usr/bin/env node
// 生成自签名 HTTPS 证书（S8 部署前置，2026-08-11）——openssl 生成到 data/certs/
// 用途：开发/内网部署的 HTTPS 加密（浏览器自签警告属预期；生产用正式证书替换 HTTPS_CERT/HTTPS_KEY 即可）
// 用法：node scripts/gen-cert.mjs [CN] [额外SAN逗号分隔] —— CN 默认 localhost
//   多 SAN 覆盖本地与局域网：node scripts/gen-cert.mjs localhost 192.168.3.80
//   （2026-08-13：原仅单 IP，localhost 访问证书不匹配 ERR_CERT_AUTHORITY_INVALID——扩展多 SAN：
//    CN=localhost 自动含 DNS:localhost + IP:127.0.0.1；额外 SAN 按 IP/DNS 判断）
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const certDir = path.join(root, 'data', 'certs');
const args = process.argv.slice(2);
const cn = args[0] || 'localhost';
const extra = (args[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// 构建 SAN：CN 自身 + 额外条目；IP 判断按纯数字+点
const isIp = (v) => /^\d{1,3}(\.\d{1,3}){3}$/.test(v);
const sanParts = new Set();
if (cn === 'localhost') { sanParts.add('DNS:localhost'); sanParts.add('IP:127.0.0.1'); }
else sanParts.add(isIp(cn) ? `IP:${cn}` : `DNS:${cn}`);
for (const e of extra) sanParts.add(isIp(e) ? `IP:${e}` : `DNS:${e}`);
const san = `subjectAltName=${[...sanParts].join(',')}`;

fs.mkdirSync(certDir, { recursive: true });
const keyFile = path.join(certDir, 'server.key');
const crtFile = path.join(certDir, 'server.crt');

const subj = `/CN=${cn}`;
execFile('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048',
  '-keyout', keyFile, '-out', crtFile,
  '-days', '3650', '-nodes',
  '-subj', subj,
  '-addext', san,
], (err) => {
  if (err) {
    console.error('生成失败（请确认 openssl 已安装并在 PATH）：', err.message);
    process.exit(1);
  }
  console.log(`自签名证书已生成：`);
  console.log(`  key:  ${keyFile}`);
  console.log(`  cert: ${crtFile}`);
  console.log(`  CN:   ${cn}`);
  console.log(`  SAN:  ${san}`);
  console.log('启用 HTTPS：设置环境变量 HTTPS_ENABLED=1 后重启后端（默认端口 3443，可用 HTTPS_PORT 覆盖）。');
  console.log('生产环境请用正式证书，通过 HTTPS_CERT / HTTPS_KEY 指定路径。');
});
