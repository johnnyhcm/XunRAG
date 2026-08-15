// i18n 框架（PRD §5.3 国际化，2026-08-13 定稿）
// - 语言标签 BCP47：zh-CN（主语言）/ en-US；fallback zh-CN（en 缺 key 回退中文）
// - 语言确定优先级：用户档案 language（/api/me 注入）> localStorage 手动切换 > navigator.language 兜底
// - 切换器改动写 localStorage（policybot-lang），档案字段作为默认来源（后端阶段接入）
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './locales/zh.json';
import en from './locales/en.json';

const LANG_KEY = 'policybot-lang';
export type AppLang = 'zh-CN' | 'en-US';

/** 当前界面是否为中文（辅助展示格式：中文括号等） */
export function isZhUI(): boolean {
  return (i18n.language ?? '').startsWith('zh');
}

function detectLanguage(): AppLang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'zh-CN' || saved === 'en-US') return saved;
  } catch { /* 无 localStorage */ }
  const nav = (navigator.language ?? '').toLowerCase();
  if (nav.startsWith('zh')) return 'zh-CN';
  if (nav.startsWith('en')) return 'en-US';
  return 'zh-CN';
}

/** 手动切换语言（写 localStorage + changeLanguage） */
export function setAppLanguage(lang: AppLang): void {
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
  void i18n.changeLanguage(lang);
}

/** 当前界面语言（BCP47） */
export function getAppLanguage(): AppLang {
  return (i18n.language ?? '').startsWith('zh') ? 'zh-CN' : 'en-US';
}

/** 用户档案语言覆盖（登录后 /api/me 有 language 时调用；仅在用户未手动切换过时生效）
 *  2026-08-13：档案 language 为权威，localStorage 手动切换次之——手动切换过则以手动为准（避免档案覆盖用户即时选择） */
export function applyProfileLanguage(lang?: string | null): void {
  if (!lang) return;
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'zh-CN' || saved === 'en-US') return; // 用户手动切换过，尊重手动选择
  } catch { /* ignore */ }
  if (lang === 'zh-CN' || lang === 'en-US') void i18n.changeLanguage(lang);
}

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zh },
    'en-US': { translation: en },
  },
  lng: detectLanguage(),
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
});

export default i18n;
