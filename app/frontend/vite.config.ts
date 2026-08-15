import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 前端 dev server：局域网 HTTPS（2026-08-11）——host:true 局域网可访问；https 读 data/certs/（gen-cert.mjs 生成，CN=机器 IP）
// 代理 /api → 后端 127.0.0.1:3000（同机内部转发，后端默认只绑本机不外露）
// 2026-08-11：watch.usePolling——Windows 文件事件偶发丢失导致 Vite transform 缓存空模块（坏缓存），轮询监听根治
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  server: {
    // 2026-08-11：端口可配置（VITE_PORT 覆盖，默认 5173）；strictPort 防静默换端口（被占用直接报错，避免"以为还是 5173 实际变了"）
    port: Number(process.env.VITE_PORT) || 5173,
    strictPort: true,
    host: true, // 局域网监听（同事经 https://机器IP:端口 访问）
    https: {
      key: fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/certs/server.key')),
      cert: fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/certs/server.crt')),
    },
    watch: { usePolling: true, interval: 300 },
    proxy: {
      '/api': {
        // 2026-08-11：后端端口可配置（BACKEND_PORT 覆盖，默认 3000）——与后端 PORT env 联动
        target: `http://127.0.0.1:${Number(process.env.BACKEND_PORT) || 3000}`,
        changeOrigin: true,
      },
    },
  },
});