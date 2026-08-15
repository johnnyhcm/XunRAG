// 政策阅读页水印（防截图溯源，2026-08-07，S7 安全前置）
// - 内容：当前用户姓名 + 工号 + 访问时间（防泄密可溯源到人）
// - 形态：45° 斜向平铺（单个 SVG tile 做背景），透明度 10%——正常阅读可见但不干扰，截图后清晰可辨
// - 定位：fixed 覆盖视口——无论滚动到哪一屏水印始终在视口上，随手截图（截当前视口）必带水印
//   （注：absolute 方案在滚动容器内只覆盖首屏，滚动后下方无水印，2026-08-07 修复）
// - 打印：beforeprint 注入 fixed 水印层——打印版每页重复带水印（不依赖浏览器"打印背景图形"设置）
// - 随机类名：增加 DevTools 定位/删除水印的难度
// - 开关：管理后台 > 系统配置 > 通用 > 阅读页水印（common.security.watermark_enabled，默认开）
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../store/session';
import { Me } from '../lib/policy-api';
import { authFetch } from '../lib/api';

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function Watermark({ enabled: forced }: { enabled?: boolean }) {
  const { t } = useTranslation();
  const userId = useSessionStore((s) => s.userId);
  // 配置未加载完成前默认开（安全优先：宁可误开不可漏开）
  const [enabled, setEnabled] = useState(true);
  const [who, setWho] = useState(t('watermark.visitor'));
  const [now, setNow] = useState(() => fmt(new Date()));
  const cls = useMemo(() => `wm-${Math.random().toString(36).slice(2, 10)}`, []);

  // 配置开关：enabled prop 显式传入时（密级策略决定）忽略全局；否则读全局（2026-08-12）
  useEffect(() => {
    if (forced !== undefined) { setEnabled(forced); return; }
    authFetch('/api/configs').then((r) => r.json()).then((d: any) => {
      const v = d.configs?.find((c: any) => c.key === 'common.security.watermark_enabled')?.value ?? '1';
      setEnabled(v !== '0');
    }).catch(() => { /* 拉取失败保持默认开 */ });
  }, [forced]);

  // 当前身份（跟随身份切换）+ 时间每分钟刷新
  useEffect(() => {
    let alive = true;
    const timer = setInterval(() => setNow(fmt(new Date())), 60_000);
    Me.get().then((m) => {
      if (!alive || !m?.user) return;
      setWho(m.user.employee_no ? `${m.user.name} ${m.user.employee_no}` : m.user.name);
    }).catch(() => alive && setWho(t('watermark.visitor')));
    return () => { alive = false; clearInterval(timer); };
  }, [userId, t]);

  // 打印：注入 fixed 水印层（每打印页重复出现）
  useEffect(() => {
    if (!enabled) return;
    const mark = `${who} ${now}`;
    const inject = () => {
      const layer = document.createElement('div');
      layer.className = cls + '-p';
      layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;opacity:.18;';
      // 每页四个角位置，旋转 -30°，打印分页时 fixed 元素每页重复渲染
      const pos: [string, string][] = [['6%', '4%'], ['58%', '8%'], ['8%', '62%'], ['55%', '70%']];
      layer.innerHTML = pos.map(([l, t]) =>
        `<div style="position:absolute;left:${l};top:${t};transform:rotate(-30deg);font-size:14px;white-space:nowrap;color:#000;">${mark}</div>`).join('');
      document.body.appendChild(layer);
    };
    const cleanup = () => { document.querySelectorAll('.' + cls + '-p').forEach((el) => el.remove()); };
    window.addEventListener('beforeprint', inject);
    window.addEventListener('afterprint', cleanup);
    return () => { window.removeEventListener('beforeprint', inject); window.removeEventListener('afterprint', cleanup); cleanup(); };
  }, [enabled, who, now, cls]);

  if (!enabled) return null;

  const mark = `${who} ${now}`;
  const svg = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="220"><text x="150" y="115" text-anchor="middle" transform="rotate(-30 150 115)" fill="#666666" font-size="14" font-family="Microsoft YaHei, PingFang SC, sans-serif" opacity="0.10">${mark}</text></svg>`,
  );
  return (
    <div className={cls} aria-hidden
      style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 5,
        backgroundImage: `url("data:image/svg+xml,${svg}")`,
        backgroundRepeat: 'repeat', backgroundSize: '300px 220px',
      }} />
  );
}
