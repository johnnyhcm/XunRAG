// 列显隐 + 列宽偏好（2026-08-11，管理后台表格统一）——localStorage 持久化个人偏好（按 storageKey 隔离）
import { useState } from 'react';

export interface ColPref { show?: boolean; width?: number }

export function useColPrefs(storageKey: string) {
  const [colPrefs, setColPrefs] = useState<Record<string, ColPref>>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) ?? '{}'); } catch { return {}; }
  });
  const saveColPrefs = (next: Record<string, ColPref>) => {
    setColPrefs(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* 存储不可用时静默 */ }
  };
  const setColWidth = (key: string, width: number) => saveColPrefs({ ...colPrefs, [key]: { ...colPrefs[key], width } });
  const toggleCol = (key: string) => saveColPrefs({ ...colPrefs, [key]: { ...colPrefs[key], show: !(colPrefs[key]?.show ?? true) } });
  const resetCols = () => { try { localStorage.removeItem(storageKey); } catch { /* ignore */ } setColPrefs({}); };
  return { colPrefs, setColWidth, toggleCol, resetCols };
}

/** 列是否显示（默认显示） */
export const colVisible = (prefs: Record<string, ColPref>, key: string) => prefs[key]?.show !== false;
/** 列宽（默认取定义宽度） */
export const colWidth = (prefs: Record<string, ColPref>, key: string, def: number) => prefs[key]?.width ?? def;
