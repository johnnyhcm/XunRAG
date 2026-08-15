// 全局网页标题（2026-08-11）：读配置 common.home.title（产品名称，顶栏/首页/浏览器标签统一）
// 模块级缓存避免多页面重复请求；GET /api/configs 公开无鉴权（登录页也可读）
import { api } from './api';
import i18n from '../i18n';

let cachedTitle: string | null = null;

export async function fetchAppTitle(fallback?: string): Promise<string> {
  // 默认兜底走 i18n（英文界面显示英文产品名，配置 common.home.title 覆盖）
  const fb = fallback ?? i18n.t('app.title', { defaultValue: '企业政策 AI' });
  if (cachedTitle) return cachedTitle;
  let title = fb;
  try {
    const r = await api.get('/configs');
    const t = r.data?.configs?.find((c: any) => c.key === 'common.home.title')?.value;
    if (t) title = String(t);
  } catch {
    /* 保持 fallback */
  }
  cachedTitle = title;
  document.title = title;
  return title;
}
