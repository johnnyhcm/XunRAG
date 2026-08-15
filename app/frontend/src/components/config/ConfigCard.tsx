// 参数配置 Card（PRD §4.4.9）——2026-08-11 从 ConfigPage 拆出（Vite 大文件 HMR 坏缓存根治）
// 交互：本地编辑 → 点 Card 级「保存改动」才提交；有改动项高亮 + 未保存计数
import { useEffect, useState } from 'react';
import { Card, Form, Switch, InputNumber, Input, Select, Button, Space, Tag, App, Tooltip } from 'antd';
import { PlusOutlined, DeleteOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { authFetch } from '../../lib/api';

export interface ConfigItem {
  key: string; module: string; section: string; label: string; type: string;
  value: string | null; default_value: string; variables?: string | null; options?: string | null; description?: string | null;
  i18n?: number | null; value_zh?: string | null; value_en?: string | null; // 2026-08-14：双语维护（i18n=1 → 显示英文值编辑区；value_zh=原始中文、value_en=原始英文）
}
/** 单项目前显示值（draft）与编辑状态（i18n 项含 value_en 草稿） */
type Draft = { value: string | null; value_en: string | null; reset: boolean };

export const SECTION_LABEL: Record<string, string> = {
  intent: '1. 理解问题', retrieve: '2. 检索政策', generate: '3. 组织回答', reply: '4. 回答之后',
  prompt: '提示词', home: '首页欢迎区', ui: '体验文案', feedback: '反馈', session: '会话', tool: '工具',
  security: '安全', thinking: '思考', // 2026-08-13：智能模式推理开关 section（PRD §4.4.9 智能 1.思考）
};
/** locale 感知的 section 标签（zh 兜底） */
export function sectionLabel(t: (k: string, o?: any) => string, sec: string): string {
  return t(`config.section.${sec}`, { defaultValue: SECTION_LABEL[sec] ?? sec });
}

// ---------- 单项编辑器（受控：draft/dirty/onEdit/onReset，不直接保存） ----------
/** 按类型渲染控件（中文值/英文值共用；i18n 项仅 text/list/textarea 出现） */
function renderControl(item: ConfigItem, value: string, onChange: (v: string) => void) {
  if (item.type === 'list') {
    const arr = (() => { try { const a = JSON.parse(value); return Array.isArray(a) ? a : []; } catch { return []; } })();
    return <ListEditor items={arr.map(String)} onChange={(items) => onChange(JSON.stringify(items))} />;
  }
  if (item.type === 'textarea') {
    return (
      <Input.TextArea value={value} rows={Math.min(8, Math.max(3, value.length / 60))}
        onChange={(e) => onChange(e.target.value)} placeholder={item.default_value} />
    );
  }
  // 短文本/其他（bool/number/select 由调用方走专用控件，不经过这里）
  return <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={item.default_value} />;
}

function ConfigEditor({ item, draft, dirty, onEdit, onEditEn, onReset, currentEn }: {
  item: ConfigItem; draft: string; dirty: boolean; onEdit: (v: string) => void; onEditEn: (v: string) => void; onReset: () => void; currentEn: string;
}) {
  const { t } = useTranslation();
  // 有改动 → 高亮边框
  const wrapStyle: React.CSSProperties = dirty
    ? { border: '1px solid #1677ff', borderRadius: 6, padding: '8px 10px', background: '#f0f7ff' }
    : {};

  let control: React.ReactNode = null;
  if (item.type === 'bool') {
    control = (
      <Switch checked={draft === '1'} onChange={(v) => onEdit(v ? '1' : '0')} />
    );
  } else if (item.type === 'number') {
    control = <InputNumber value={Number(draft)} onChange={(v) => onEdit(String(v ?? ''))} style={{ width: 180 }} />;
  } else if (item.type === 'select') {
    const opts = (() => { try { return JSON.parse(item.options ?? '[]'); } catch { return []; } })();
    control = (
      <Select value={draft} onChange={(v) => onEdit(String(v))} style={{ width: 260 }}
        options={opts.map((o: any) => ({ value: String(o.value), label: String(o.label) }))} />
    );
  } else {
    control = renderControl(item, draft, onEdit);
  }

  return (
    <div style={wrapStyle}>
      <Form.Item
        label={<Space size={4} wrap>
          {item.label}
          {dirty && <Tag color="blue" style={{ marginInlineEnd: 0 }}>{t('config.unsaved')}</Tag>}
          {/* 2026-08-14：i18n 项英文值为空 → 橙色「EN 未填写」提醒 */}
          {item.i18n === 1 && !currentEn && <Tag color="orange" style={{ marginInlineEnd: 0 }}>{t('config.enMissing')}</Tag>}
          {item.variables ? (
            <Tooltip title={<div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{t('config.varsTip', { vars: item.variables })}</div>}>
              <Tag color="blue" style={{ marginInlineEnd: 0, cursor: 'pointer' }}>{t('config.vars')}</Tag>
            </Tooltip>
          ) : null}
        </Space>}
        style={{ marginBottom: 0 }}
      >
        {control}
        {/* 2026-08-14：双语维护——i18n 项显示英文值编辑区（同类型控件） */}
        {item.i18n === 1 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>{t('config.enValueLabel')}</div>
            {renderControl(item, currentEn, onEditEn)}
          </div>
        )}
      </Form.Item>
      {item.description ? (
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 10px', lineHeight: 1.6 }}>{item.description}</div>
      ) : null}
      <Button size="small" type="link" icon={<ReloadOutlined />} onClick={onReset} style={{ padding: 0, height: 'auto' }}>
        {t('config.resetDefault')}
      </Button>
    </div>
  );
}

// ---------- 列表编辑器（本地编辑，onChange 上报，随 Card 保存） ----------
function ListEditor({ items, onChange }: { items: string[]; onChange: (items: string[]) => void }) {
  const { t } = useTranslation();
  const [list, setList] = useState(items);
  const [adding, setAdding] = useState('');
  useEffect(() => { setList(items); }, [items]);
  const emit = (next: string[]) => { setList(next); onChange(next); };
  return (
    <div>
      {list.map((it, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          <Input value={it} onChange={(e) => { const n = [...list]; n[i] = e.target.value; emit(n); }} style={{ maxWidth: 360 }} />
          <Button size="small" icon={<DeleteOutlined />} onClick={() => emit(list.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Space style={{ marginTop: 4 }}>
        <Input size="small" placeholder={t('config.addItem')} value={adding} onChange={(e) => setAdding(e.target.value)} style={{ width: 200 }} />
        <Button size="small" icon={<PlusOutlined />} onClick={() => { if (adding.trim()) { emit([...list, adding.trim()]); setAdding(''); } }}>{t('config.add')}</Button>
      </Space>
    </div>
  );
}

// ---------- 步骤 Card（维护本区草稿，统一保存） ----------
export default function ConfigCard({ title, items, onSaved }: { title: string; items: ConfigItem[]; onSaved: () => void }) {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);
  const dirtyKeys = Object.keys(drafts);

  /** 配置项原始中文值（i18n 项用 value_zh，其余用 value） */
  const rawZh = (c: ConfigItem) => c.value_zh ?? c.value ?? c.default_value;
  /** 配置项原始英文值（可能为空） */
  const rawEn = (c: ConfigItem) => c.value_en ?? '';

  const edit = (key: string, field: 'value' | 'value_en', value: string) => {
    const c = items.find((x) => x.key === key)!;
    setDrafts((d) => {
      const base = d[key] ?? { value: rawZh(c), value_en: rawEn(c), reset: false };
      return { ...d, [key]: { ...base, [field]: value, reset: false } };
    });
  };
  const reset = (key: string) => setDrafts((d) => ({ ...d, [key]: { value: null, value_en: null, reset: true } }));

  const saveAll = async () => {
    setSaving(true);
    try {
      for (const [key, d] of Object.entries(drafts)) {
        const c = items.find((x) => x.key === key);
        const body: any = { value: d.reset ? null : d.value };
        if (c?.i18n === 1) body.value_en = d.reset ? null : d.value_en ?? null; // 2026-08-14：i18n 项同次提交英文值
        const r = await authFetch(`/api/configs/${key}`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(await r.text());
      }
      message.success(t('config.savedN', { count: dirtyKeys.length }));
      setDrafts({});
      onSaved();
    } catch (e: any) { message.error(t('config.saveFailed', { msg: e.message })); }
    finally { setSaving(false); }
  };

  return (
    <Card
      size="small"
      title={<Space>{title}{dirtyKeys.length > 0 && <Tag color="blue">{t('config.unsavedN', { count: dirtyKeys.length })}</Tag>}</Space>}
      extra={
        <Button type="primary" size="small" icon={<SaveOutlined />}
          disabled={!dirtyKeys.length} loading={saving} onClick={saveAll}>
          {dirtyKeys.length ? `${t('config.saveChanges')}（${dirtyKeys.length}）` : t('config.saveChanges')}
        </Button>
      }
      style={{ marginBottom: 12 }}
    >
      <Form layout="vertical">
        {items.map((c) => {
          const d = drafts[c.key];
          const currentZh = d ? (d.reset ? c.default_value : d.value ?? '') : rawZh(c);
          const currentEn = d ? (d.reset ? '' : d.value_en ?? '') : rawEn(c);
          return (
            <ConfigEditor key={c.key} item={c} draft={currentZh} dirty={!!d} currentEn={currentEn}
              onEdit={(v) => edit(c.key, 'value', v)}
              onEditEn={(v) => edit(c.key, 'value_en', v)}
              onReset={() => reset(c.key)} />
          );
        })}
      </Form>
    </Card>
  );
}
