// AI 运行指示灯（2026-08-10 动态：云端=服务商/模型/Key；本地=模型/引擎/显存）——2026-08-11 从 ConfigPage 拆出
// 只放「问答配置」「模型接入」两页（模型状态相关处）；10s 轮询（本地模型异步加载 30-60s）
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, authFetch } from '../../lib/api';
import type { HealthResponse } from '@policybot/shared';
import { PROVIDER_OPTIONS } from './modelOptions';

interface LocalStatus {
  running: boolean; loaded: boolean; model_file: string | null;
  gpu?: { total_mb: number; used_mb: number; free_mb: number } | null;
}
interface LlmState {
  mode: 'cloud' | 'local'; provider: string; model: string | null; has_key: boolean; local?: LocalStatus;
}

export default function ConfigStatusLights() {
  const { t } = useTranslation();
  const [llm, setLlm] = useState<LlmState | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [h, mc, ls] = await Promise.all([
          api.get<HealthResponse>('/health'),
          authFetch('/api/model-config').then((r) => r.json()).catch(() => null),
          authFetch('/api/local-model/status').then((r) => r.json()).catch(() => null),
        ]);
        if (!alive) return;
        setHealth(h.data);
        if (mc) setLlm({
          mode: mc.mode === 'local' ? 'local' : 'cloud',
          provider: mc.provider ?? '',
          model: mc.model ?? null,
          has_key: Boolean(mc.has_key),
          local: ls ? { running: ls.running, loaded: ls.loaded, model_file: mc.local?.model_file ?? null, gpu: ls.gpu ?? null } : undefined,
        });
      } catch { /* 灯不可用时静默 */ }
    };
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const llmOk: boolean | null = !llm ? null
    : llm.mode === 'local' ? (llm.local?.running ? (llm.local.loaded ? true : null) : false)
    : llm.has_key;
  const llmLabel = !llm ? t('statusLights.checking')
    : llm.mode === 'local'
      ? t('statusLights.llmLocal', {
          model: llm.local?.model_file ? String(llm.local.model_file).split('/').pop() : t('statusLights.noModel'),
          state: llm.local?.running ? (llm.local.loaded ? t('statusLights.running') : t('statusLights.starting')) : t('statusLights.stopped'),
        })
        + (llm.local?.running && llm.local.loaded && llm.local.gpu ? ` · ${t('statusLights.gpu', { used: (llm.local.gpu.used_mb / 1024).toFixed(1), total: (llm.local.gpu.total_mb / 1024).toFixed(0), free: (llm.local.gpu.free_mb / 1024).toFixed(1) })}` : '')
    : t('statusLights.llmCloud', {
        provider: PROVIDER_OPTIONS.find((p) => p.value === llm.provider)?.label ?? llm.provider,
        model: llm.model ?? t('statusLights.noModel'),
        key: llm.has_key ? t('statusLights.keyConfigured') : t('statusLights.keyNotConfigured'),
      });
  const pyOk = health?.python === 'up' ? true : health?.python === 'down' ? false : null;
  const dot = (ok: boolean | null) => ({ width: 10, height: 10, borderRadius: 5, background: ok === null ? '#999' : ok ? '#52c41a' : '#ff4d4f', display: 'inline-block', marginRight: 6 });

  return (
    // 2026-08-11：窄屏适配——容器/灯内均可换行（文案不变，长标签折行显示不截断）
    <div style={{ display: 'flex', flexWrap: 'wrap', rowGap: 6, columnGap: 24, alignItems: 'center', background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 13 }}>
      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 4, minWidth: 0 }}><span style={dot(llmOk)} />{llmLabel}</span>
      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 4, minWidth: 0 }}><span style={dot(pyOk)} />{t('statusLights.py', { state: pyOk === null ? t('statusLights.checking') : pyOk ? t('statusLights.pyOk') : t('statusLights.pyDown') })}</span>
    </div>
  );
}
