// 模型接入 Tab（S7 ⑤，2026-08-09）——2026-08-11 从 ConfigPage 拆出（Vite 大文件 HMR 坏缓存根治）
// 云端 API 配置：provider + baseUrl + 模型（动态拉取）+ API Key（AES 加密文件，各服务商独立存储）
// 本地模型：llama.cpp 系统托管（切模式自动启停）；一键切换（Segmented 即保存 mode）
import { useEffect, useState } from 'react';
import {
  Card, Form, Switch, InputNumber, Input, Select, Button, Space, Tag, App, AutoComplete, Alert, Segmented,
} from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { authFetch } from '../../lib/api';
import { PROVIDER_OPTIONS, PROVIDER_DEFAULT_URL, providerLabel as providerLabelFn } from './modelOptions';
import { isZhUI } from '../../i18n';

export default function ModelConfigTab({ onChanged }: { onChanged: () => void }) {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [cfg, setCfg] = useState<any>(null);
  const [models, setModels] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  // 本地模式状态
  const [localModels, setLocalModels] = useState<{ name: string; file: string; size_mb: number; has_meta: boolean }[]>([]);
  const [localStatus, setLocalStatus] = useState<{ running: boolean; loaded: boolean; configured: boolean; error?: string; gpu?: { total_mb: number; used_mb: number; free_mb: number } | null } | null>(null);
  const [mode, setMode] = useState<'cloud' | 'local'>('cloud');
  // 2026-08-10：当前表单选中的服务商（换 provider 时显示该服务商的 key 掩码/状态，不重填）
  const selProvider = Form.useWatch('provider', form) ?? cfg?.provider ?? 'deepseek';
  const selKeyStatus = cfg?.keys?.[selProvider]; // { has_key, masked }

  const load = async () => {
    try {
      const d = await authFetch('/api/model-config').then((r) => r.json());
      setCfg(d);
      setMode(d.mode === 'local' ? 'local' : 'cloud');
      form.setFieldsValue({
        provider: d.provider,
        base_url: d.base_url ?? PROVIDER_DEFAULT_URL[d.provider] ?? '',
        model: d.model ?? undefined,
        // 本地参数
        ctx_size: d.local?.ctx_size ?? 16384,
        kv_quantize: Boolean(d.local?.kv_quantize),
        gpu_layers: d.local?.gpu_layers ?? 40,
        concurrency: d.local?.concurrency ?? 2,
      });
      if (d.has_key && d.mode !== 'local') {
        // 2026-08-11 修复竞态：用刚拉取的配置判断（不依赖 setState 后的 cfg），云端且有 key 才自动拉模型列表，失败静默
        setLoadingModels(true);
        authFetch('/api/model-config/models').then((r) => r.json()).then((d2) => {
          if (Array.isArray(d2.models)) setModels(d2.models);
        }).catch(() => { /* 列表拉取失败不打扰 */ }).finally(() => setLoadingModels(false));
      }
      if (d.mode === 'local') { scanLocal(); refreshLocalStatus(); }
    } catch { /* 无权限/未登录等静默 */ }
  };
  useEffect(() => { load(); }, []);

  // ---------- 本地模式 ----------
  const scanLocal = async () => {
    try {
      const d = await authFetch('/api/local-model/models').then((r) => r.json());
      setLocalModels(d.models ?? []);
    } catch { setLocalModels([]); }
  };
  const refreshLocalStatus = async () => {
    try {
      const d = await authFetch('/api/local-model/status').then((r) => r.json());
      setLocalStatus(d);
    } catch { setLocalStatus(null); }
  };
  const localAction = async (action: 'start' | 'stop' | 'test') => {
    setTesting(true); setTestResult(null);
    try {
      const body = action === 'test' && form.getFieldValue('model_file') ? { model_file: form.getFieldValue('model_file') } : undefined;
      const r = await authFetch(`/api/local-model/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        if (action === 'test') setTestResult({ ok: true, msg: t('modelConfig.testOk', { sec: ((d.latency_ms ?? 0) / 1000).toFixed(1) }) });
        else setTestResult({ ok: true, msg: action === 'start' ? t('modelConfig.started') : t('modelConfig.stoppedMsg') });
        refreshLocalStatus();
      } else setTestResult({ ok: false, msg: d.error ?? t('fieldDicts.opsFailed') });
    } catch (e: any) { setTestResult({ ok: false, msg: e?.message ?? t('fieldDicts.opsFailed') }); }
    finally { setTesting(false); }
  };

  const refreshModels = async () => {
    const v = form.getFieldsValue();
    const hasFormKey = Boolean(v.api_key && v.api_key.trim());
    // key 状态按当前选中的服务商判断（各服务商独立存储）
    if (!hasFormKey && !selKeyStatus?.has_key) {
      setTestResult({ ok: false, msg: t('modelConfig.needKey') });
      return;
    }
    if (!hasFormKey && selProvider !== cfg?.provider) {
      setTestResult({ ok: false, msg: t('modelConfig.needKeyProvider') });
      return;
    }
    setLoadingModels(true);
    try {
      const r = hasFormKey
        ? await authFetch('/api/model-config/test', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: v.provider, base_url: v.base_url, api_key: v.api_key.trim() }),
          })
        : await authFetch('/api/model-config/models');
      if (!r.ok) { setModels([]); setTestResult({ ok: false, msg: (await r.json().catch(() => ({})))?.error ?? t('modelConfig.fetchFailed') }); return; }
      const d = await r.json();
      setModels(d.models ?? []);
      if (d.models?.length) setTestResult({ ok: true, msg: t('modelConfig.fetched', { count: d.models.length }) });
      else if (d.note) setTestResult({ ok: true, msg: d.note });
    } catch { setModels([]); }
    finally { setLoadingModels(false); }
  };

  const onProviderChange = (v: string) => {
    form.setFieldsValue({ base_url: PROVIDER_DEFAULT_URL[v] ?? '', model: undefined, api_key: undefined });
    setModels([]);
    setTestResult(null);
  };

  const test = async () => {
    const v = await form.validateFields();
    const hasKey = Boolean(v.api_key && v.api_key.trim()) || Boolean(selKeyStatus?.has_key);
    if (!hasKey) { message.warning(t('modelConfig.keyWarning')); return; }
    if (!(v.api_key && v.api_key.trim()) && selProvider !== cfg?.provider) {
      message.warning(t('modelConfig.keyWarningProvider'));
      return;
    }
    setTesting(true); setTestResult(null);
    try {
      const r = await authFetch('/api/model-config/test', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: v.provider, base_url: v.base_url, api_key: v.api_key || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        setTestResult({ ok: true, msg: d.note ? t('modelConfig.connectOkNote', { note: d.note }) : t('modelConfig.connectOk', { count: d.models?.length ?? 0 }) });
        setModels(d.models ?? []);
      }
      else setTestResult({ ok: false, msg: d.error ?? t('modelConfig.connectFailed') });
    } catch (e: any) { setTestResult({ ok: false, msg: e?.message ?? t('modelConfig.connectFailed') }); }
    finally { setTesting(false); }
  };

  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const body: any = { mode };
      if (mode === 'cloud') {
        body.provider = v.provider; body.base_url = v.base_url || null; body.model = v.model || null;
        if (v.api_key && v.api_key.trim()) body.api_key = v.api_key.trim();
        if (v.clear_key) body.clear_key = true;
      } else {
        // 本地：模型 + 参数
        body.model_file = v.model_file || null;
        body.ctx_size = Number(v.ctx_size) || 16384;
        body.kv_quantize = v.kv_quantize ? 1 : 0;
        body.gpu_layers = Number(v.gpu_layers) || 0;
        body.concurrency = Number(v.concurrency) || 2;
      }
      const r = await authFetch('/api/model-config', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.text()) || t('modelConfig.saveFailed', { msg: '' }));
      message.success(t('modelConfig.saved'));
      form.setFieldValue('api_key', undefined);
      setTestResult(null);
      load(); onChanged();
    } catch (e: any) { message.error(t('modelConfig.saveFailed', { msg: e.message })); }
    finally { setSaving(false); }
  };

  // 模式一键切换——Segmented 即保存 mode（只提交 mode，不动参数），成功刷新、失败回滚
  const switchMode = async (v: 'cloud' | 'local') => {
    if (v === mode) return;
    const prev = mode;
    setMode(v); setTestResult(null);
    try {
      const r = await authFetch('/api/model-config', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: v }),
      });
      if (!r.ok) throw new Error(await r.text());
      message.success(v === 'local' ? t('modelConfig.switchedLocal') : t('modelConfig.switchedCloud'));
      load(); onChanged(); // onChanged → 顶部 LLM 灯刷新
      if (v === 'local') { scanLocal(); refreshLocalStatus(); }
    } catch (e: any) {
      message.error(t('modelConfig.switchFailed', { msg: e?.message ?? e }));
      setMode(prev); // 回滚到保存态
    }
  };

  // 掩码跟随当前选中的服务商（各服务商独立 key，换 provider 直接显示其掩码）
  const masked = selKeyStatus?.masked ?? null;
  const providerLabel = providerLabelFn(t, selProvider);
  return (
    <Card size="small" title={t('modelConfig.title')} style={{ maxWidth: 800, marginBottom: 12 }}
      extra={
        <Space>
          {mode === 'cloud' && <Button size="small" icon={<ReloadOutlined />} loading={testing || loadingModels} onClick={test}>{t('modelConfig.testConnect')}</Button>}
          {mode === 'local' && (
            <Button size="small" type="primary" icon={<ReloadOutlined />} loading={testing} onClick={() => localAction('test')}>{t('modelConfig.startAndTest')}</Button>
          )}
          <Button type="primary" size="small" icon={<SaveOutlined />} loading={saving} onClick={save}>{t('modelConfig.saveConfig')}</Button>
        </Space>
      }>
      {/* 2026-08-10 简化：状态信息集中在顶部 LLM 灯；切模式自动启停引擎（后端联动） */}
      <Space style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: '#555' }}>{t('modelConfig.modeLabel')}</span>
        <Segmented value={mode} options={[{ label: t('modelConfig.cloudApi'), value: 'cloud' }, { label: t('modelConfig.localModel'), value: 'local' }]}
          onChange={(v) => switchMode(v as 'cloud' | 'local')} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('modelConfig.modeHint')}</span>
      </Space>
      {cfg && !cfg.master_key_configured && mode === 'cloud' && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message={t('modelConfig.masterKeyWarnTitle')}
          description={t('modelConfig.masterKeyWarnDesc')} />
      )}

      {mode === 'local' ? (
        <Form form={form} layout="vertical" style={{ maxWidth: 560 }}>
          <Form.Item label={t('modelConfig.fModelFile')} name="model_file" extra={t('modelConfig.fModelFileExtra')}
            rules={[{ required: true, message: t('modelConfig.fModelFileRequired') }]}>
            <Select placeholder={t('modelConfig.fModelFilePh')}
              onChange={() => setTestResult(null)}
              options={localModels.map((m) => ({ value: m.file, label: isZhUI() ? `${m.name}（${(m.size_mb / 1024).toFixed(1)}GB）` : `${m.name} (${(m.size_mb / 1024).toFixed(1)}GB)` }))}
              notFoundContent={<Button size="small" type="link" onClick={scanLocal} icon={<ReloadOutlined />}>{t('modelConfig.rescan')}</Button>}
            />
          </Form.Item>
          <Form.Item label={t('modelConfig.fCtxSize')} name="ctx_size" extra={t('modelConfig.fCtxSizeExtra')}>
            <InputNumber min={1024} max={262144} step={1024} style={{ width: 200 }} />
          </Form.Item>
          <Form.Item label={t('modelConfig.fKvQuantize')} name="kv_quantize" extra={t('modelConfig.fKvQuantizeExtra')}>
            <Switch />
          </Form.Item>
          <Form.Item label={t('modelConfig.fGpuLayers')} name="gpu_layers" extra={t('modelConfig.fGpuLayersExtra')}>
            <InputNumber min={-1} style={{ width: 160 }} />
          </Form.Item>
          <Form.Item label={t('modelConfig.fConcurrency')} name="concurrency" extra={t('modelConfig.fConcurrencyExtra')}>
            <InputNumber min={1} max={16} style={{ width: 160 }} />
          </Form.Item>
          {localStatus && (
            <div style={{ marginBottom: 12, fontSize: 13 }}>
              {t('modelConfig.engineStatus')}{localStatus.running
                ? <Tag color={localStatus.loaded ? 'green' : 'orange'}>{localStatus.loaded ? t('modelConfig.runningLoaded') : t('modelConfig.starting')}</Tag>
                : <Tag color="default">{t('modelConfig.stopped')}</Tag>}
              {localStatus.error && <span style={{ color: '#cf1322', marginLeft: 8, fontSize: 12 }}>{localStatus.error}</span>}
            </div>
          )}
        </Form>
      ) : (
        <Form form={form} layout="vertical" style={{ maxWidth: 560 }}>
          <Form.Item label={t('modelConfig.fProvider')} name="provider" rules={[{ required: true }]}>
            <Select options={PROVIDER_OPTIONS} onChange={onProviderChange} />
          </Form.Item>
          <Form.Item label={t('modelConfig.fBaseUrl')} name="base_url"
            rules={[{ required: true, message: t('modelConfig.fBaseUrlRequired') }]}
            extra={cfg?.source === 'env' || cfg?.source === 'file' ? t('modelConfig.fBaseUrlExtraEnv') : t('modelConfig.fBaseUrlExtra')}>
            <Input placeholder={t('modelConfig.fBaseUrlPh')} />
          </Form.Item>
          <Form.Item label={t('modelConfig.fModel')} name="model"
            extra={
              <Space size={4}>
                <span>{t('modelConfig.fModelExtra')}</span>
                <Button size="small" type="link" icon={<ReloadOutlined />} loading={loadingModels} onClick={refreshModels} style={{ padding: 0, height: 'auto' }}>{t('modelConfig.refreshList')}</Button>
              </Space>
            }>
            <AutoComplete
              options={models.map((m) => ({ value: m }))}
              placeholder={models.length ? t('modelConfig.fModelPh1') : t('modelConfig.fModelPh2')}
              filterOption={(input, opt) => String(opt?.value ?? '').toLowerCase().includes(input.toLowerCase())}
            />
          </Form.Item>
          <Form.Item label={t('modelConfig.fApiKey')} name="api_key"
            extra={
              <span style={{ userSelect: 'none' }}>
                {masked
                  ? <><b>{t('modelConfig.keyMasked', { provider: providerLabel, masked })}</b>{t('modelConfig.keyMaskedHint')}</>
                  : t('modelConfig.keyMissing', { provider: providerLabel })}
              </span>
            }>
            <Input.Password visibilityToggle={false} placeholder={masked ? t('modelConfig.keyKeep') : 'sk-...'} autoComplete="new-password" />
          </Form.Item>
        </Form>
      )}
      {testResult && (
        <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 6, fontSize: 13,
          background: testResult.ok ? '#f6ffed' : '#fff2f0', border: `1px solid ${testResult.ok ? '#b7eb8f' : '#ffccc7'}` }}>
          {testResult.ok ? '✅ ' : '❌ '}{testResult.msg}
        </div>
      )}
      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)', lineHeight: 1.7 }}>
        {mode === 'local' ? t('modelConfig.localNote') : t('modelConfig.cloudNote')}
      </div>
    </Card>
  );
}
