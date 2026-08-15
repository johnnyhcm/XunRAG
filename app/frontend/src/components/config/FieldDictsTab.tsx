// 用户属性（field_dicts + field_dict_options，2026-08-11 重构）——从 ConfigPage 拆出（Vite 大文件 HMR 坏缓存根治）
// 值/名分离：value 稳定编码匹配用 / label 显示名可改可多语言；选项可增/改名/停用/删除（引用检查）
// 内置字段 is_system=1 不可停用/删除；预留字段 custom_1~10 可停用、未引用可删除；必填可配置（required）
// 字段行「字段属性」→ 弹窗（字段信息 + 选项管理）；CSV 批量维护（全量清单）
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { App, Button, Checkbox, Divider, Dropdown, Form, Input, Modal, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined, ArrowUpOutlined, ArrowDownOutlined, MoreOutlined, DownloadOutlined } from '@ant-design/icons';
import { authFetch } from '../../lib/api';
import { FieldDicts, type FieldDict, type FieldDictOption } from '../../lib/policy-api';
import { isZhUI } from '../../i18n';

const TYPE_LABEL: Record<string, string> = { option: '单选', multi: '多选', text: '文本' };
const TYPE_KEY: Record<string, string> = { option: 'fieldDicts.type.option', multi: 'fieldDicts.type.multi', text: 'fieldDicts.type.text' };

export default function FieldDictsTab() {
  const { message, modal } = App.useApp();
  const { i18n, t } = useTranslation();
  const fieldName = (f: FieldDict) => ((i18n.language ?? 'zh').toLowerCase().startsWith('zh') ? f.name : (f.name_i18n?.en || f.name));
  const [fields, setFields] = useState<FieldDict[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editField, setEditField] = useState<FieldDict | null>(null);
  const [createForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const [optForm] = Form.useForm();
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvField, setCsvField] = useState<FieldDict | null>(null);
  // 2026-08-11：选项改名受控草稿（optionId → 编辑中的 label）——失焦/回车提交；「保存字段」统一提交未保存改名，杜绝静默丢失
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  // 2026-08-13：选项英文名（label_en）同样支持行内编辑（i18n 双列）
  const [labelEnDrafts, setLabelEnDrafts] = useState<Record<string, string>>({});

  const load = async () => {
    setLoading(true);
    try { const r = await FieldDicts.list(); setFields(r.fields ?? []); } catch { message.error(t('fieldDicts.loadFailed')); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const reloadEdit = async () => {
    if (!editField) return;
    const r = await FieldDicts.list();
    setEditField(r.fields.find((f) => f.key === editField.key) ?? null);
  };

  const createField = async (v: any) => {
    try {
      await FieldDicts.create({
        name: v.name, type: v.type ?? 'option',
        name_i18n: v.name_en ? { zh: v.name, en: v.name_en } : undefined,
        options: (v.options ?? '').split(/[,，]/).map((s: string) => s.trim()).filter(Boolean).map((s: string) => ({ value: s, label: s })),
      });
      message.success(t('fieldDicts.created')); setCreateOpen(false); createForm.resetFields(); load();
    } catch (e: any) { message.error(e?.response?.data?.error ?? t('fieldDicts.createFailed')); }
  };

  const saveField = async (v: any) => {
    if (!editField) return;
    try {
      // 2026-08-11：先提交所有未保存的选项改名（用户改了选项名直接点「保存字段」——此前静默丢失）
      const dirty = editField.options.filter((o) => {
        const d = labelDrafts[o.id];
        return d !== undefined && d.trim() !== '' && d.trim() !== o.label;
      });
      for (const o of dirty) {
        await FieldDicts.updateOption(editField.key, o.id, { label: labelDrafts[o.id].trim() });
      }
      // 2026-08-13：未保存的英文名草稿一并提交
      const dirtyEn = editField.options.filter((o) => {
        const d = labelEnDrafts[o.id];
        return d !== undefined && d.trim() !== (o.label_en ?? '');
      });
      for (const o of dirtyEn) {
        await FieldDicts.updateOption(editField.key, o.id, { label_en: labelEnDrafts[o.id].trim() || null });
      }
      if (dirty.length) message.success(t('fieldDicts.labelsSavedN', { count: dirty.length }));
      await FieldDicts.update(editField.key, {
        name: v.name, name_i18n: v.name_en ? { zh: v.name, en: v.name_en } : null,
        type: v.type, enabled: v.enabled ? 1 : 0, required: v.required ? 1 : 0, in_context: v.in_context ? 1 : 0,
      });
      message.success(t('fieldDicts.fieldSaved')); load();
      setLabelDrafts({});
      setLabelEnDrafts({});
      // 2026-08-11：保存后直接关闭弹框（不再 reloadEdit——异步刷新会用新字段值重新打开弹框，造成"先关再弹"竞态）
      setEditField(null);
    } catch (e: any) { message.error(e?.response?.data?.error ?? t('fieldDicts.saveFailed')); }
  };

  const toggleEnabled = async (f: FieldDict) => {
    try {
      await FieldDicts.update(f.key, { enabled: f.enabled ? 0 : 1 });
      message.success(f.enabled ? t('fieldDicts.disabledMsg') : t('fieldDicts.enabledMsg')); load();
      if (editField?.key === f.key) reloadEdit();
    } catch (e: any) { message.error(e?.response?.data?.error ?? t('fieldDicts.opsFailed')); }
  };
  const removeField = async (f: FieldDict) => {
    try { await FieldDicts.remove(f.key); message.success(t('fieldDicts.removed')); load(); setEditField(null); }
    catch (e: any) { message.error(e?.response?.data?.error ?? t('fieldDicts.removeFailed')); }
  };

  const addOption = async () => {
    if (!editField) return;
    const v = optForm.getFieldsValue();
    if (!v.value || !v.label) { message.warning(t('fieldDicts.optionValueLabelRequired')); return; }
    try {
      await FieldDicts.addOption(editField.key, { value: v.value, label: v.label, label_en: v.label_en || undefined });
      message.success(t('fieldDicts.optionAdded')); optForm.resetFields(); reloadEdit();
    } catch (e: any) { message.error(e?.response?.data?.error ?? t('fieldDicts.optionAddFailed')); }
  };
  const toggleOption = async (o: FieldDictOption) => {
    if (!editField) return;
    try { await FieldDicts.updateOption(editField.key, o.id, { enabled: o.enabled ? 0 : 1 }); reloadEdit(); }
    catch (e: any) { message.error(e?.response?.data?.error ?? t('fieldDicts.opsFailed')); }
  };
  const removeOption = async (o: FieldDictOption) => {
    if (!editField) return;
    try { await FieldDicts.removeOption(editField.key, o.id); message.success(t('users.deleted')); reloadEdit(); }
    catch (e: any) { message.error(e?.response?.data?.error ?? t('fieldDicts.removeFailed')); }
  };
  // 2026-08-11：删除统一 modal.confirm（表格按钮规范）——被引用时后端会拒绝并提示改用停用
  const confirmRemoveOption = (o: FieldDictOption) => {
    if (!editField) return;
    modal.confirm({
      title: t('fieldDicts.deleteOptionTitle', { name: o.label }),
      content: t('fieldDicts.deleteOptionContent'),
      okText: t('users.deleteOk'), okButtonProps: { danger: true }, cancelText: t('action.cancel'),
      onOk: () => removeOption(o),
    });
  };
  // 2026-08-11：选项改名提交（受控草稿 → 失焦/回车触发；值未变/空不提交；成功后清草稿）
  const commitLabel = async (o: FieldDictOption) => {
    if (!editField) return;
    const draft = labelDrafts[o.id];
    if (draft === undefined || draft.trim() === '' || draft.trim() === o.label) {
      // 无实质改动：仅清无效草稿
      if (draft === undefined || draft.trim() === o.label) setLabelDrafts((d) => { const n = { ...d }; delete n[o.id]; return n; });
      return;
    }
    try {
      await FieldDicts.updateOption(editField.key, o.id, { label: draft.trim() });
      message.success(t('fieldDicts.optionRenamed'));
      setLabelDrafts((d) => { const n = { ...d }; delete n[o.id]; return n; });
      reloadEdit();
    } catch (e: any) { message.error(e?.response?.data?.error ?? t('fieldDicts.renameFailed')); }
  };
  // 2026-08-13：选项英文名提交（与中文名对称；空=清除）
  const commitLabelEn = async (o: FieldDictOption) => {
    if (!editField) return;
    const draft = labelEnDrafts[o.id];
    const cur = o.label_en ?? '';
    if (draft === undefined || draft.trim() === cur) {
      if (draft === undefined || draft.trim() === cur) setLabelEnDrafts((d) => { const n = { ...d }; delete n[o.id]; return n; });
      return;
    }
    try {
      await FieldDicts.updateOption(editField.key, o.id, { label_en: draft.trim() || null });
      message.success(t('fieldDicts.optionRenamed'));
      setLabelEnDrafts((d) => { const n = { ...d }; delete n[o.id]; return n; });
      reloadEdit();
    } catch (e: any) { message.error(e?.response?.data?.error ?? t('fieldDicts.renameFailed')); }
  };
  // 2026-08-11：上移/下移（交换相邻位置，批量排序接口一次重写 sort；排序基准=启用在前停用在后，与列表显示一致）
  const moveOption = async (o: FieldDictOption, dir: -1 | 1) => {
    if (!editField) return;
    const opts = [...editField.options].sort((a, b) => (b.enabled - a.enabled) || (a.sort - b.sort));
    const idx = opts.findIndex((x) => x.id === o.id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= opts.length) return;
    const next = [...opts];
    [next[idx], next[j]] = [next[j], next[idx]];
    try {
      await FieldDicts.sortOptions(editField.key, next.map((x) => x.id));
      message.success(t('fieldDicts.orderAdjusted'));
      reloadEdit();
    } catch (e: any) { message.error(e?.response?.data?.error ?? t('fieldDicts.opsFailed')); }
  };

  const cols = [
    { title: t('fieldDicts.colSlot'), dataIndex: 'key', width: 110 },
    { title: t('fieldDicts.colName'), dataIndex: 'name', width: 190, render: (_: string, f: FieldDict) => (
      <>{fieldName(f)}{f.is_system ? <Tag color="blue" style={{ marginLeft: 6 }}>{t('fieldDicts.system')}</Tag> : null}</>
    ) },
    { title: t('fieldDicts.colType'), dataIndex: 'type', width: 70, render: (v: string) => t(TYPE_KEY[v] ?? 'fieldDicts.type.text', { defaultValue: TYPE_LABEL[v] ?? v }) },
    // 2026-08-11：注入对话上下文状态（敏感控制；预留字段默认不注入）
    { title: t('fieldDicts.colInContext'), dataIndex: 'in_context', width: 100, render: (v: number) => (v ? <Tag color="blue">{t('fieldDicts.injected')}</Tag> : <Typography.Text type="secondary">—</Typography.Text>) },
    { title: t('fieldDicts.colStatus'), dataIndex: 'enabled', width: 80, render: (v: number) => <Tag color={v ? 'green' : 'default'}>{v ? t('users.enabled') : t('users.disabled')}</Tag> },
    // 2026-08-11：停用/删除折叠进「更多」（非常用操作）；字段属性为主按钮
    { title: t('fieldDicts.colOp'), width: 150, render: (_: any, f: FieldDict) => (
      <Space size={0}>
        <Button size="small" type="link" style={{ padding: '0 6px' }}
          onClick={() => { setEditField(f); setLabelDrafts({}); editForm.setFieldsValue({ name: f.name, name_en: f.name_i18n?.en ?? '', type: f.type, enabled: !!f.enabled, required: !!f.required, in_context: !!f.in_context }); optForm.resetFields(); }}>{t('fieldDicts.fieldAttr')}</Button>
        <Dropdown trigger={['click']}
          menu={{ items: [
            { key: 'toggle', label: f.enabled ? t('users.disabled') : t('users.enabled'), disabled: !!f.is_system, onClick: () => toggleEnabled(f) },
            { key: 'delete', label: t('users.deleteOk'), danger: true, disabled: !!f.is_system, onClick: () => modal.confirm({ title: t('fieldDicts.deleteFieldTitle', { name: f.name }), content: t('fieldDicts.deleteFieldContent'), onOk: () => removeField(f) }) },
          ] }}>
          <Button size="small" type="link" icon={<MoreOutlined />} style={{ padding: '0 6px' }} />
        </Dropdown>
      </Space>
    ) },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('fieldDicts.intro')}
        </Typography.Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>{t('fieldDicts.createField')}</Button>
      </Space>
      <Table rowKey="key" size="small" loading={loading} columns={cols} dataSource={fields} pagination={false} />

      {/* 新建字段 */}
      <Modal title={t('fieldDicts.createTitle')} open={createOpen} onOk={() => createForm.submit()} onCancel={() => setCreateOpen(false)} okText={t('admin.createOk')} width={480}>
        <Form form={createForm} onFinish={createField} layout="vertical">
          <Form.Item name="name" label={t('fieldDicts.fDisplayName')} rules={[{ required: true }]} extra={t('fieldDicts.fDisplayNameExtra')}>
            <Input placeholder={t('fieldDicts.fDisplayNamePlaceholder')} />
          </Form.Item>
          <Form.Item name="name_en" label={t('fieldDicts.fNameEn')}>
            <Input placeholder="Certification Type" />
          </Form.Item>
          <Form.Item name="type" label={t('fieldDicts.fType')} initialValue="option">
            <Select options={[{ value: 'option', label: t('fieldDicts.typeOption') }, { value: 'multi', label: t('fieldDicts.typeMulti') }, { value: 'text', label: t('fieldDicts.typeText') }]} />
          </Form.Item>
          <Form.Item name="options" label={t('fieldDicts.fInitialOptions')}>
            <Input placeholder={t('fieldDicts.fInitialOptionsPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 字段属性（保存/取消放 Modal footer 右下角；控件大小统一）*/}
      <Modal title={editField ? t('fieldDicts.fieldAttrTitle', { name: editField.name }) : ''} open={!!editField} onCancel={() => setEditField(null)} width={760} destroyOnClose
        footer={[
          <Button key="cancel" onClick={() => setEditField(null)}>{t('action.cancel')}</Button>,
          <Button key="save" type="primary" onClick={() => editForm.submit()}>{t('fieldDicts.saveField')}</Button>,
        ]}>
        {editField && (
          <div>
            <Form form={editForm} layout="vertical" onFinish={saveField} style={{ maxWidth: 520, marginBottom: 16 }}>
              <Form.Item name="name" label={t('fieldDicts.fDisplayName')} rules={[{ required: true }]}><Input /></Form.Item>
              <Form.Item name="name_en" label={t('fieldDicts.fNameEn')}><Input placeholder="Certification Type" /></Form.Item>
              <Form.Item name="type" label={t('fieldDicts.fType')}>
                <Select options={[{ value: 'option', label: t('fieldDicts.typeOption') }, { value: 'multi', label: t('fieldDicts.typeMulti') }, { value: 'text', label: t('fieldDicts.typeText') }]} disabled={!!editField.is_system && editField.options.length > 0} />
              </Form.Item>
              <Form.Item name="enabled" label={t('fieldDicts.fEnabled')} valuePropName="checked"><Switch disabled={!!editField.is_system} /></Form.Item>
              <Form.Item name="required" label={t('fieldDicts.fRequired')} valuePropName="checked" extra={editField.is_system ? t('fieldDicts.fRequiredSysExtra') : t('fieldDicts.fRequiredExtra')}>
                <Switch />
              </Form.Item>
              <Form.Item name="in_context" label={t('fieldDicts.fInContext')} valuePropName="checked" extra={t('fieldDicts.fInContextExtra')}>
                <Switch />
              </Form.Item>
            </Form>
            {editField.type === 'text' ? (
              <Typography.Text type="secondary">{t('fieldDicts.textNoOptions')}</Typography.Text>
            ) : (
              <div>
                <Space style={{ marginBottom: 8 }} wrap>
                  <Typography.Text strong>{t('fieldDicts.optionsCount', { enabled: editField.options.filter((o) => o.enabled).length, total: editField.options.length })}</Typography.Text>
                  <Button size="small" icon={<ReloadOutlined />} onClick={() => { setCsvField(editField); setCsvOpen(true); }}>{t('fieldDicts.csvBatch')}</Button>
                </Space>
                <Form form={optForm} layout="inline" style={{ marginBottom: 8 }} onFinish={addOption}>
                  <Form.Item name="value" rules={[{ required: true }]} style={{ marginBottom: 4 }}><Input placeholder={t('fieldDicts.optValuePh')} style={{ width: 170 }} /></Form.Item>
                  <Form.Item name="label" rules={[{ required: true }]} style={{ marginBottom: 4 }}><Input placeholder={t('fieldDicts.optLabelPh')} style={{ width: 110 }} /></Form.Item>
                  <Form.Item name="label_en" style={{ marginBottom: 4 }}><Input placeholder={t('fieldDicts.optLabelEnPh')} style={{ width: 110 }} /></Form.Item>
                  <Button type="primary" size="small" htmlType="submit" icon={<PlusOutlined />} style={{ marginBottom: 4 }}>{t('fieldDicts.optAdd')}</Button>
                </Form>
                <Table size="small" rowKey="id" pagination={false} dataSource={editField.options}
                  rowClassName={(r: any) => (r.enabled ? '' : 'dict-disabled')}
                  columns={[
                    { title: t('fieldDicts.optColValue'), dataIndex: 'value', width: 200 },
                    { title: t('fieldDicts.optColLabel'), dataIndex: 'label', render: (v: string, o: any) => <Input size="small" value={labelDrafts[o.id] ?? o.label}
                      onChange={(e) => setLabelDrafts((d) => ({ ...d, [o.id]: e.target.value }))}
                      onBlur={() => commitLabel(o)} onPressEnter={() => commitLabel(o)} style={{ width: 140 }} /> },
                    { title: t('fieldDicts.optColLabelEn'), dataIndex: 'label_en', render: (v: string | null, o: any) => <Input size="small" value={labelEnDrafts[o.id] ?? o.label_en ?? ''}
                      onChange={(e) => setLabelEnDrafts((d) => ({ ...d, [o.id]: e.target.value }))}
                      onBlur={() => commitLabelEn(o)} onPressEnter={() => commitLabelEn(o)} style={{ width: 140 }} placeholder={t('fieldDicts.optLabelEnPh')} /> },
                    { title: t('users.colStatus'), dataIndex: 'enabled', width: 70, render: (v: number) => <Tag color={v ? 'green' : 'default'}>{v ? t('users.enabled') : t('users.disabled')}</Tag> },
                    { title: t('users.colOp'), width: 190, render: (_: any, o: any, i: number) => (
                      <Space size={0}>
                        <Button size="small" type="link" icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => moveOption(o, -1)} style={{ padding: '0 4px' }} />
                        <Button size="small" type="link" icon={<ArrowDownOutlined />} disabled={i === editField.options.length - 1} onClick={() => moveOption(o, 1)} style={{ padding: '0 4px' }} />
                        <Button size="small" type="link" style={{ padding: '0 6px' }} onClick={() => toggleOption(o)}>{o.enabled ? t('users.disabled') : t('users.enabled')}</Button>
                        <Button size="small" type="link" danger style={{ padding: '0 6px' }} onClick={() => confirmRemoveOption(o)}>{t('users.deleteOk')}</Button>
                      </Space>
                    ) },
                  ]} />
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* CSV 批量更新 */}
      <CsvOptionModal field={csvField} open={csvOpen} onClose={() => setCsvOpen(false)} onDone={() => { setCsvOpen(false); load(); reloadEdit(); }} />
    </div>
  );
}

// ---------- 选项 CSV 批量更新（全量清单：校验先行 → 预览 → 执行；编码自动识别，与用户 CSV 一致）----------
function CsvOptionModal({ field, open, onClose, onDone }: { field: FieldDict | null; open: boolean; onClose: () => void; onDone: () => void }) {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [disableUnlisted, setDisableUnlisted] = useState(false);

  useEffect(() => { setFile(null); setPreview(null); setDisableUnlisted(false); }, [open]);

  // 2026-08-11：下载现有选项（全量清单工作流：下载 → 修改 → 上传）；UTF-8 BOM（Excel 打开中文不乱码）
  const downloadOptions = () => {
    if (!field) return;
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = ['value,label,label_en,enabled,sort'];
    for (const o of [...field.options].sort((a, b) => a.sort - b.sort)) {
      lines.push([o.value, o.label, o.label_en ?? '', o.enabled ? 1 : 0, o.sort].map((x) => esc(String(x))).join(','));
    }
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${field.name}-${isZhUI() ? '选项' : 'options'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doRequest = async (dryRun: boolean) => {
    if (!field || !file) { message.warning(t('fieldDicts.csvNoFile')); return; }
    const fd = new FormData();
    fd.append('file', file);
    setBusy(true);
    try {
      const q = dryRun ? 'dryRun=1' : (disableUnlisted ? 'disableUnlisted=1' : '');
      const r = await authFetch(`/api/field_dicts/${field.key}/options/csv?${q}`, { method: 'POST', body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { message.error(d.error ?? t('fieldDicts.csvFailed')); return; }
      if (dryRun) setPreview(d.preview);
      else { message.success(t('fieldDicts.csvDone', { added: d.stats?.added ?? 0, updated: d.stats?.updated ?? 0 })); onDone(); }
    } catch (e: any) { message.error(e?.message ?? t('fieldDicts.csvFailed')); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={t('fieldDicts.csvTitle', { name: field?.name ?? '' })} open={open} onCancel={onClose} width={580}
      footer={preview ? [
        <Button key="back" onClick={() => setPreview(null)}>{t('fieldDicts.back')}</Button>,
        <Button key="run" type="primary" loading={busy} onClick={() => doRequest(false)}>{t('fieldDicts.confirmRun')}</Button>,
      ] : [
        <Button key="preview" type="primary" loading={busy} onClick={() => doRequest(true)}>{t('fieldDicts.validatePreview')}</Button>,
      ]}>
      <div style={{ marginBottom: 12, fontSize: 13, lineHeight: 1.7 }} dangerouslySetInnerHTML={{ __html: t('fieldDicts.csvIntro') }} />
      <Space style={{ marginBottom: 8 }} wrap>
        <Button size="small" icon={<DownloadOutlined />} onClick={downloadOptions}>{t('fieldDicts.csvDownload')}</Button>
        <input type="file" accept=".csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Space>
      {preview && (
        <div style={{ background: '#f6ffed', border: '1px solid #b7eb8f', borderRadius: 6, padding: 10, fontSize: 13 }} dangerouslySetInnerHTML={{ __html: t('fieldDicts.csvPreviewStats', { added: preview.added, updated: preview.updated }) }}>
        </div>
      )}
      {preview?.unlisted?.length ? (
        <div style={{ marginTop: 6 }}>
          <div>{t('fieldDicts.csvUnlisted', { count: preview.unlisted.length, names: preview.unlisted.slice(0, 8).join('、') + (preview.unlisted.length > 8 ? '…' : '') })}</div>
          <Checkbox checked={disableUnlisted} onChange={(e) => setDisableUnlisted(e.target.checked)}>{t('fieldDicts.csvDisableUnlisted')}</Checkbox>
        </div>
      ) : null}
    </Modal>
  );
}
