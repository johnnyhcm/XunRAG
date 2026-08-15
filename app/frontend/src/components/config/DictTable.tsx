// 数据字典表格（问答路由：主题/意图/流程/对接人）——2026-08-11 从 ConfigPage 拆出（Vite 大文件 HMR 坏缓存根治）
// 2026-08-10 整改：删除→停用 / 意图禁新增 / 编辑弹窗体验（中文 label / 下拉引用 / JSON 校验 / 必填）
import { useEffect, useState } from 'react';
import { Button, Select, Input, InputNumber, Table, Modal, Form, Space, Tag, App, Alert } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { authFetch } from '../../lib/api';
import { isZhUI } from '../../i18n';

interface DictFieldDef {
  key: string; label: string;
  type?: 'text' | 'textarea' | 'number' | 'json' | 'select-topic' | 'select-user' | 'select-region';
  required?: boolean; extra?: string;
}
interface DictMeta { title: string; hint?: string; creatable: boolean; fields: DictFieldDef[] }
/** 字典元数据（locale 感知：字段 label/extra 走 i18n） */
const buildDictMeta = (t: (k: string, o?: any) => string): Record<string, DictMeta> => ({
  topics: {
    title: t('dict.topicsTitle'), creatable: true,
    fields: [
      { key: 'name', label: t('dict.fName'), required: true },
      { key: 'name_en', label: t('dict.fNameEn') },
      { key: 'keywords', label: t('dict.fKeywords'), type: 'json', extra: t('dict.fKeywordsExtra') },
      { key: 'scope', label: t('dict.fScope'), type: 'textarea', extra: t('dict.fScopeExtra') },
      { key: 'sort', label: t('dict.fSort'), type: 'number' },
      { key: 'description', label: t('dict.fDescription') },
    ],
  },
  intents: {
    title: t('dict.intentsTitle'), creatable: false,
    hint: t('dict.intentsHint'),
    fields: [
      { key: 'name', label: t('dict.fName'), required: true },
      { key: 'name_en', label: t('dict.fNameEn') },
      { key: 'prompt_desc', label: t('dict.fPromptDesc'), type: 'textarea', required: true, extra: t('dict.fPromptDescExtra') },
      { key: 'sort', label: t('dict.fSort'), type: 'number' },
      { key: 'description', label: t('dict.fDescription') },
    ],
  },
  processes: {
    title: t('dict.processesTitle'), creatable: true,
    fields: [
      { key: 'name', label: t('dict.fName'), required: true },
      { key: 'name_en', label: t('dict.fNameEn') },
      { key: 'url', label: t('dict.fUrl'), required: true, extra: t('dict.fUrlExtra') },
      { key: 'topic_id', label: t('dict.fTopic'), type: 'select-topic', extra: t('dict.fTopicExtra') },
      { key: 'keywords', label: t('dict.fKeywords'), type: 'json', extra: t('dict.fKeywordsExtra') },
      { key: 'sort', label: t('dict.fSort'), type: 'number' },
      { key: 'description', label: t('dict.fDescription') },
    ],
  },
  routes: {
    title: t('dict.routesTitle'), creatable: true,
    fields: [
      { key: 'topic_id', label: t('dict.fRouteTopic'), type: 'select-topic', required: true },
      { key: 'region', label: t('dict.fRegion'), type: 'select-region', extra: t('dict.fRegionExtra') },
      { key: 'contact_user_id', label: t('dict.fContact'), type: 'select-user', required: true },
      { key: 'sort', label: t('dict.fSort'), type: 'number' },
      { key: 'description', label: t('dict.fDescription') },
    ],
  },
});

export default function DictTable({ name, onChanged }: { name: string; onChanged: () => void }) {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const meta = buildDictMeta(t)[name] ?? { title: name, creatable: true, fields: [] };
  const [items, setItems] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [form] = Form.useForm();
  const [topics, setTopics] = useState<any[]>([]); // select-topic 选项源
  const [users, setUsers] = useState<any[]>([]);   // select-user 选项源
  const [regionOptions, setRegionOptions] = useState<{ value: string; label: string }[]>([]); // select-region 选项源（选项字段·地区，label 按语言）

  const load = () => authFetch(`/api/configs/dicts/${name}`).then((r) => r.json()).then((d) => setItems(d.items ?? []));
  useEffect(() => { load(); }, [name]);
  useEffect(() => {
    if (meta.fields.some((f) => f.type === 'select-topic'))
      authFetch('/api/configs/dicts/topics').then((r) => r.json()).then((d) => setTopics(d.items ?? [])).catch(() => setTopics([]));
    if (meta.fields.some((f) => f.type === 'select-user'))
      authFetch('/api/users').then((r) => r.json()).then((d) => setUsers(d.users ?? [])).catch(() => setUsers([]));
    if (meta.fields.some((f) => f.type === 'select-region'))
      authFetch('/api/field_dicts').then((r) => r.json()).then((d) => {
        const f = (d.fields ?? []).find((x: any) => x.key === 'region');
        setRegionOptions(Array.isArray(f?.options)
          ? f.options.filter((o: any) => o.enabled).map((o: any) => ({ value: o.value, label: isZhUI() ? o.label : (o.label_en || o.label) }))
          : []);
      }).catch(() => setRegionOptions([]));
  }, [name]);

  const openEdit = (rec: any) => {
    setEditing(rec);
    // select-region 字段值解析（JSON 数组 / 旧单值 / 空 → 数组）
    if (meta.fields.some((f) => f.type === 'select-region')) {
      const v = rec.region;
      let arr: string[] = [];
      if (v) { try { const p = JSON.parse(v); if (Array.isArray(p)) arr = p.map(String); } catch { arr = [String(v)]; } }
      form.setFieldsValue({ ...rec, region: arr });
    } else form.setFieldsValue(rec);
  };
  const closeEdit = () => { setEditing(null); form.resetFields(); };

  // 停用/启用（可逆；各查询均过滤 enabled=1，停用即时从意图识别/流程/路由消失）
  const toggle = async (rec: any) => {
    const next = rec.enabled ? 0 : 1;
    try {
      const r = await authFetch(`/api/configs/dicts/${name}/${rec.id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { message.error(d.error || t('dict.opsFailed')); return; }
      message.success(next ? t('dict.enabledMsg') : t('dict.disabledMsg'));
      load(); onChanged();
    } catch (e: any) { message.error(t('dict.opsFailed') + '：' + (e?.message ?? e)); }
  };

  const save = async (id: string | null, values: any) => {
    const payload: any = { ...values };
    // JSON 字段：空 → 不提交（走默认）；非空 → 校验并规范化
    for (const f of meta.fields) {
      if (f.type === 'json') {
        const v = payload[f.key];
        if (v === undefined || v === null || String(v).trim() === '') delete payload[f.key];
        else { try { payload[f.key] = JSON.stringify(JSON.parse(v)); } catch { message.error(t('dict.notJson', { label: f.label })); return; } }
      }
      // select-region 多选——非空序列化 JSON 数组；空显式提交 null（=主题级兑底）
      if (f.type === 'select-region') {
        const v = payload[f.key];
        payload[f.key] = Array.isArray(v) && v.length ? JSON.stringify(v) : null;
      }
    }
    const method = id ? 'PUT' : 'POST';
    const url = id ? `/api/configs/dicts/${name}/${id}` : `/api/configs/dicts/${name}`;
    try {
      const r = await authFetch(url, {
        method, headers: { 'content-type': 'application/json' },
        body: JSON.stringify(id ? payload : { id: payload.id ?? undefined, ...payload }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { message.error(d.error || t('dict.saveFailed')); return; }
      message.success(t('dict.saved'));
      closeEdit();
      load(); onChanged();
    } catch (e: any) { message.error(t('dict.saveFailed') + '：' + (e?.message ?? e)); }
  };

  // 表格列：ID + 主名称列 + 各字典附加列 + 状态 + 操作
  const nameCol = meta.fields[0] ?? { key: 'name', label: t('dict.nameCol') };
  const extraCol: Record<string, any> = {
    topics: { title: t('dict.extraScope'), dataIndex: 'scope', ellipsis: true, render: (v: any) => v || '—' },
    intents: { title: t('dict.extraPrompt'), dataIndex: 'prompt_desc', ellipsis: true, render: (v: any) => v || '—' },
    processes: { title: t('dict.extraUrl'), dataIndex: 'url', ellipsis: true, render: (v: any) => (v ? <a href={v} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{v}</a> : '—') },
    routes: { title: t('dict.extraTopic'), dataIndex: 'topic_name', width: 110, render: (v: any) => v || '—' },
  };
  const cols: any[] = [
    { title: 'ID', dataIndex: 'id', width: 120 },
    { title: nameCol.label, dataIndex: nameCol.key },
    ...(name === 'processes' ? [{
      title: t('dict.relTopic'), dataIndex: 'topic_id', width: 110,
      render: (v: any) => topics.find((t) => t.id === v)?.name ?? (v ? v : '—'),
    }] : []),
    ...(name === 'routes' ? [{ title: t('dict.colContact'), dataIndex: 'contact_name', width: 110, render: (v: any) => v || '—' }, { title: t('dict.colRegion'), dataIndex: 'region', width: 150, render: (v: any) => {
      if (!v || v === '[]' || v === '') return t('dict.general');
      const lbl = (x: string) => regionOptions.find((o) => o.value === x)?.label ?? x;
      try { const arr = JSON.parse(v); if (Array.isArray(arr) && arr.length) return <Space size={4} wrap>{arr.map((r) => <Tag key={r}>{lbl(r)}</Tag>)}</Space>; } catch { /* 旧单值 */ }
      return <Tag>{lbl(v)}</Tag>;
    } }] : []),
    ...(name !== 'routes' && name !== 'processes' ? [extraCol[name]] : []),
    { title: t('dict.colStatus'), dataIndex: 'enabled', width: 70, render: (v: any) => <Tag color={v ? 'green' : 'default'}>{v ? t('dict.enabled') : t('dict.disabled')}</Tag> },
    { title: t('dict.colOp'), key: 'op', width: 110, render: (_: any, rec: any) => (
      <Space size={0} onClick={(e) => e.stopPropagation()}>
        <Button size="small" type="link" style={{ padding: '0 6px' }} onClick={() => openEdit(rec)}>{t('dict.edit')}</Button>
        <Button size="small" type="link" style={{ padding: '0 6px' }} onClick={() => toggle(rec)}>{rec.enabled ? t('dict.disable') : t('dict.enable')}</Button>
      </Space>
    ) },
  ];

  // 字段控件渲染
  const renderField = (f: DictFieldDef) => {
    if (f.type === 'textarea') return <Input.TextArea rows={3} placeholder={f.extra} />;
    if (f.type === 'number') return <InputNumber style={{ width: 160 }} min={0} />;
    if (f.type === 'select-topic') return (
      <Select allowClear placeholder={t('dict.selectTopic')}
        options={topics.filter((t) => t.enabled !== 0).map((t) => ({ value: t.id, label: t.name }))} />
    );
    if (f.type === 'select-region') return (
      <Select mode="tags" placeholder={t('dict.selectRegion')}
        options={regionOptions.map((r) => ({ value: r.value, label: r.label }))}
        tokenSeparators={[',']} maxTagCount="responsive" />
    );
    if (f.type === 'select-user') return (
      <Select showSearch optionFilterProp="label" placeholder={t('dict.selectUser')}
        options={users.map((u) => ({ value: u.id, label: isZhUI() ? `${u.name}（${u.employee_no ?? ''}${u.department ? ' · ' + u.department : ''}）` : `${u.name} (${u.employee_no ?? ''}${u.department ? ' · ' + u.department : ''})` }))} />
    );
    return <Input placeholder={f.extra} />;
  };

  return (
    <div>
      {meta.hint && <Alert type="info" showIcon style={{ marginBottom: 12 }} message={meta.hint} />}
      <Space style={{ marginBottom: 8 }}>
        {meta.creatable && (
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => { setEditing({}); form.resetFields(); }}>{t('dict.add')}</Button>
        )}
      </Space>
      <Table size="small" rowKey="id" dataSource={items} columns={cols}
        pagination={false} scroll={{ x: 820 }}
        onRow={(rec) => ({ onClick: () => openEdit(rec) })}
        rowClassName={(rec) => (rec.enabled ? '' : 'dict-disabled')} />
      <Modal open={!!editing} title={editing?.id ? t('dict.editTitle', { title: meta.title }) : t('dict.newTitle', { title: meta.title })} onCancel={closeEdit}
        onOk={() => form.submit()} destroyOnClose width={560}>
        <Form form={form} layout="vertical" onFinish={(v) => save(editing?.id ?? null, v)}>
          {!editing?.id && (
            <Form.Item label={t('dict.idLabel')} name="id"
              rules={[{ required: true, message: t('dict.idRequired') }, { pattern: /^[a-z][a-z0-9_-]*$/, message: t('dict.idPattern') }]}>
              <Input placeholder={t('dict.idPlaceholder')} />
            </Form.Item>
          )}
          {meta.fields.map((f) => (
            <Form.Item key={f.key} label={f.label} name={f.key} extra={f.extra}
              rules={[
                ...(f.required ? [{ required: true, message: t('dict.requiredField', { label: f.label }) }] : []),
                ...(f.type === 'json' ? [{ validator: (_: any, v: any) => {
                  if (!v || String(v).trim() === '') return Promise.resolve();
                  try { JSON.parse(v); return Promise.resolve(); } catch { return Promise.reject(new Error(t('dict.jsonError'))); }
                } }] : []),
              ]}>
              {renderField(f)}
            </Form.Item>
          ))}
        </Form>
      </Modal>
    </div>
  );
}
