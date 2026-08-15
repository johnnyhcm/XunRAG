// 用户管理（S6 前置最小版，PRD §4.1.5）
// 列表：姓名/工号搜索 + 状态过滤；新建/编辑弹窗；停用/启用（无物理删除）
// 保护：admin 禁停用、转人工联系人禁停用（后端校验，前端同步置灰）；角色可编辑（测权限实时生效）
import { useEffect, useState } from 'react';
import { App, Alert, Button, Col, Divider, Dropdown, Empty, Form, Input, Modal, Result, Row, Select, Space, Table, Tag, Typography, Upload } from 'antd';
import { PlusOutlined, ReloadOutlined, ImportOutlined, DownloadOutlined, InboxOutlined, MoreOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { Users, type UserRow, type ImportResult, type FieldDict } from '../lib/policy-api';
import { isZhUI } from '../i18n';
import { api } from '../lib/api';
import { ResizableTitle } from '../components/table/ResizableTitle';
import { useColPrefs, colVisible, colWidth } from '../components/table/useColPrefs';
import ColumnSettings from '../components/table/ColumnSettings';

// 属性选项（2026-08-07 定稿；S6 升级为后台配置选项表 + 中英双语 + id 存储）
export const USER_OPTIONS = {
  regions: ['中国北京', '中国深圳', '美国加州'],
  contractTypes: ['正式', '实习', '外包'],
  levelTypes: ['高管', '管理者', 'IC'],
  departments: ['人力资源部', '技术部', '销售部', '制造部', '财务部', '行政部', '市场部'],
  positions: ['经理', '主管', '专员', '工程师', '分析师', '销售代表', 'HR专员', '财务专员'],
  roles: ['admin', 'employee'],
};
const ROLE_LABEL: Record<string, string> = { admin: '管理员', employee: '员工' };

export default function UserManage() {
  const { message, modal } = App.useApp();
  const { t } = useTranslation();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string>('');
  // 2026-08-11：列头排序（服务端；默认工号升序）——sortOrder: 'ascend'/'descend'/undefined=取消
  const [sortState, setSortState] = useState<{ field: string; order: 'ascend' | 'descend' | undefined }>({ field: 'employee_no', order: 'ascend' });
  const SORTABLE = new Set(['employee_no', 'name', 'department', 'region', 'contract_type', 'level_type', 'status']);
  const [modalOpen, setModalOpen] = useState(false);
  // CSV 导入向导（三步：上传/粘贴 → 预览 → 结果）+ 导出（2026-08-07，PRD §4.1.5 闭环）
  const [importOpen, setImportOpen] = useState(false);
  const [importStep, setImportStep] = useState(1);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  // 2026-08-11：选项/预留字段动态化——下拉选项与自定义字段从 field_dicts 读（值/名分离：显示 label 提交 value）
  const [fieldDicts, setFieldDicts] = useState<FieldDict[]>([]);
  useEffect(() => {
    api.get('/field_dicts').then((r) => setFieldDicts(r.data.fields ?? [])).catch(() => {});
  }, []);
  const optOf = (key: string) => fieldDicts.find((f) => f.key === key)?.options.filter((o) => o.enabled).map((o) => ({ value: o.value, label: isZhUI() ? o.label : (o.label_en || o.label) })) ?? [];
  const customFields = fieldDicts.filter((f) => f.enabled && f.key.startsWith('custom_'));
  // 2026-08-13：字段显示名按语言（zh→name；en→name_i18n.en ?? name）
  const fieldName = (f: FieldDict): string => (isZhUI() ? f.name : (f.name_i18n?.en || f.name));
  // 2026-08-11：必填动态化——业务级必填由 field_dicts.required 决定（工号/姓名系统必填在下方写死）
  const reqRule = (key: string, msg: string) => (fieldDicts.find((f) => f.key === key)?.required ? [{ required: true, message: msg }] : []);

  const load = async () => {    setLoading(true);
    try {
      const { users: list } = await Users.list({
        search: query || undefined, status: status || undefined,
        sortBy: sortState.field, sortOrder: sortState.order === 'descend' ? 'desc' : 'asc',
      });
      setUsers(list);
    } catch (e: any) { message.error(t('users.loadFailed', { msg: e?.message ?? e })); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [query, status, sortState]);

  // CSV 导入（2026-08-07）：文件/粘贴 → dryRun 预览 → 确认提交；导出/模板下载（UTF-8 BOM）
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };
  const handleFile = async (file: File) => {
    setImporting(true);
    try {
      const r = await Users.importFile(file, true);
      setImportFile(file); setPreview(r); setImportStep(2);
    } catch (e: any) { message.error(e?.response?.data?.error ?? t('users.previewFailed')); }
    finally { setImporting(false); }
  };
  const pasteImport = async () => {
    if (!csvText.trim()) return;
    await handleFile(new File([csvText], 'paste.csv', { type: 'text/csv' }));
  };
  const doCommit = async () => {
    if (!importFile) return;
    setImporting(true);
    try {
      const r = await Users.importFile(importFile, false);
      setImportResult(r); setImportStep(3);
      message.success(t('users.importDone', { created: r.created, updated: r.updated, hint: r.created > 0 ? t('users.importDoneHint') : '' }));
      load();
    } catch (e: any) { message.error(e?.response?.data?.error ?? t('users.importFailed')); }
    finally { setImporting(false); }
  };
  const doExport = async () => {
    try {
      const blob = await Users.exportCsv();
      downloadBlob(blob, `users_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.csv`);
      message.success(t('users.exported'));
    } catch { message.error(t('users.exportFailed')); }
  };
  const downloadTemplate = async () => {
    try { downloadBlob(await Users.template(), 'user_template.csv'); } catch { message.error(t('users.templateFailed')); }
  };
  const openImport = () => { setImportStep(1); setImportFile(null); setPreview(null); setImportResult(null); setImportOpen(true); };

  const openCreate = () => { setEditing(null); form.resetFields(); setModalOpen(true); };
  const openEdit = (u: UserRow) => {
    setEditing(u);
    const vals: any = {
      employee_no: u.employee_no, name: u.name, department: u.department, position: u.position,
      email: u.email, phone: u.phone, region: u.region, contract_type: u.contract_type,
      level_type: u.level_type,
    };
    // 预留字段回填（multi 值 JSON → 数组）
    for (const f of customFields) {
      if (f.type === 'multi' && u[f.key]) { try { vals[f.key] = JSON.parse(u[f.key]); } catch { vals[f.key] = []; } }
      else vals[f.key] = u[f.key] ?? undefined;
    }
    form.setFieldsValue(vals);
    setModalOpen(true);
  };

  const submit = async () => {
    const v: any = await form.validateFields();
    // 预留字段序列化（multi 数组 → JSON 字符串；空 → null）
    for (const f of customFields) {
      if (f.type === 'multi') v[f.key] = Array.isArray(v[f.key]) && v[f.key].length ? JSON.stringify(v[f.key]) : null;
      else if (v[f.key] === '') v[f.key] = null;
    }
    setSaving(true);
    try {
      if (editing) await Users.update(editing.id, v);
      else await Users.create(v);
      // 2026-08-11：新建后必须提醒管理员初始密码（转告用户）；登录页不再公开统一密码
      message.success(editing
        ? t('users.saved')
        : t('users.created', { name: v.name }));
      setModalOpen(false);
      load();
    } catch (e: any) { message.error(e?.response?.data?.error ?? String(e?.message ?? e)); }
    finally { setSaving(false); }
  };

  const toggleStatus = async (u: UserRow) => {
    try {
      if (u.status === 'active') await Users.deactivate(u.id);
      else await Users.activate(u.id);
      message.success(u.status === 'active' ? t('users.deactivated', { name: u.name }) : t('users.activated', { name: u.name }));
      load();
    } catch (e: any) { message.error(e?.response?.data?.error ?? String(e?.message ?? e)); }
  };

  const isProtected = (u: UserRow) => u.id === 'admin' || (u.status === 'active' && /^contact-/.test(u.id));

  // 2026-08-11：列显隐 + 拖拽调宽（公共组件，localStorage 持久化个人偏好）
  const { colPrefs, setColWidth, toggleCol, resetCols } = useColPrefs('userManageColPrefs');

  // 列定义（key=列标识；status/op 固定列；custom 动态加入）
  const builtinAttrCols = [
    { key: 'employee_no', title: t('users.colEmployeeNo'), width: 90 },
    { key: 'name', title: t('users.colName'), width: 90 },
    { key: 'department', title: t('users.colDepartment'), width: 110 },
    { key: 'region', title: t('users.colRegion'), width: 100 },
    { key: 'contract_type', title: t('users.colContractType'), width: 90 },
    { key: 'level_type', title: t('users.colLevelType'), width: 90 },
  ];
  const allColDefs = [
    ...builtinAttrCols,
    ...customFields.map((f) => ({ key: f.key, title: fieldName(f), width: 110 })),
    { key: 'status', title: t('users.colStatus'), width: 80 },
    { key: 'op', title: t('users.colOp'), width: 150 },
  ];

  const customRender = (f: any) => (v: any) => {
    if (v == null || v === '') return '—';
    if (f.type === 'multi') { try { const a = JSON.parse(v); return Array.isArray(a) && a.length ? <Space size={2} wrap>{a.map((x: string) => { const o = f.options?.find((op: any) => op.value === x); return <Tag key={x}>{o ? (isZhUI() ? o.label : (o.label_en || o.label)) : x}</Tag>; })}</Space> : '—'; } catch { return v; } }
    return v;
  };

  const cols = allColDefs
    .filter((c) => colVisible(colPrefs, c.key))
    .map((c) => {
      const w = colWidth(colPrefs, c.key, c.width);
      const col: any = { key: c.key, title: c.title, width: w };
      if (c.key !== 'op') col.dataIndex = c.key;
      // 2026-08-11：可排序列（白名单）加列头排序——服务端执行，点击切换升/降/取消
      if (SORTABLE.has(c.key)) {
        col.sorter = true;
        col.sortOrder = sortState.field === c.key ? sortState.order : undefined;
      }
      if (['employee_no', 'department', 'region', 'contract_type', 'level_type'].includes(c.key)) col.render = (v: string) => v || '—';
      if (c.key.startsWith('custom_')) col.render = customRender(customFields.find((f) => f.key === c.key));
      if (c.key === 'status') col.render = (v: string) => (v === 'active' ? <Tag color="green">{t('users.enabled')}</Tag> : <Tag>{t('users.disabled')}</Tag>);
      if (c.key === 'op') col.render = (_: unknown, u: UserRow) => (
        <Space size="small">
          <Button size="small" type="link" onClick={() => openEdit(u)}>{t('dict.edit')}</Button>
          <Button size="small" type="link" onClick={() => modal.confirm({
            title: t('users.resetConfirmTitle', { name: u.name }),
            content: t('users.resetConfirmContent'),
            okText: t('users.resetOk'), cancelText: t('action.cancel'),
            onOk: async () => { try { await Users.resetPassword(u.id); message.success(t('users.resetDone')); } catch (e: any) { message.error(e?.response?.data?.error ?? t('users.resetFailed')); } },
          })}>{t('users.resetPassword')}</Button>
          {isProtected(u)
            ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{u.id === 'admin' ? t('users.systemUser') : t('users.contact')}</Typography.Text>
            : (
              // 2026-08-11：停用/删除为非常用操作，折叠进「更多」
              <Dropdown trigger={['click']}
                menu={{ items: [
                  { key: 'toggle', label: u.status === 'active' ? t('users.disabled') : t('users.enabled'), onClick: () => toggleStatus(u) },
                  { key: 'delete', label: t('users.deleteOk'), danger: true, onClick: () => modal.confirm({
                    title: t('users.deleteConfirmTitle', { name: u.name }),
                    content: t('users.deleteConfirmContent'),
                    okText: t('users.deleteOk'), okButtonProps: { danger: true }, cancelText: t('action.cancel'),
                    onOk: async () => { try { await Users.remove(u.id); message.success(t('users.deleted')); load(); } catch (e: any) { message.error(e?.response?.data?.error ?? t('users.deleteFailed')); } },
                  }) },
                ] }}>
                <Button size="small" type="text" icon={<MoreOutlined />} />
              </Dropdown>
            )}
        </Space>
      );
      col.onHeaderCell = () => ({ width: w, onResize: (nw: number) => setColWidth(c.key, nw) });
      return col;
    });

  return (
    <div className="admin-page" style={{ padding: 24, height: 'calc(100vh - 52px)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <Typography.Title level={4} style={{ margin: 0, marginBottom: 16, flexShrink: 0 }}>{t('console.users')}</Typography.Title>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search placeholder={t('users.searchPlaceholder')} allowClear style={{ width: 220 }} onSearch={setQuery} />
        <Select
          placeholder={t('users.statusPlaceholder')} allowClear style={{ width: 110 }}
          value={status || undefined} onChange={(v) => setStatus(v ?? '')}
          options={[{ value: 'active', label: t('users.enabled') }, { value: 'inactive', label: t('users.disabled') }]}
        />
        <Button icon={<ReloadOutlined />} onClick={load}>{t('users.refresh')}</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('users.create')}</Button>
        <Button icon={<ImportOutlined />} onClick={openImport}>{t('users.importCsv')}</Button>
        <Button icon={<DownloadOutlined />} onClick={doExport}>{t('users.export')}</Button>
        {/* 2026-08-11：列设置（公共组件；个人偏好存 localStorage） */}
        <ColumnSettings defs={allColDefs} colPrefs={colPrefs} onToggle={toggleCol} onReset={resetCols} />
      </Space>

      {/* 导入向导（三步：上传/粘贴 → 预览校验 → 结果报告）2026-08-07 */}
      <Modal title={t('users.importTitle')} open={importOpen} onCancel={() => setImportOpen(false)} footer={null} width={680}>
        {importStep === 1 && (
          <div>
            <Alert type="info" showIcon style={{ marginBottom: 12 }}
              message={t('users.importHint')} />
            <Space style={{ marginBottom: 12 }}>
              <Button icon={<DownloadOutlined />} onClick={downloadTemplate}>{t('users.downloadTemplate')}</Button>
            </Space>
            <Upload.Dragger accept=".csv" showUploadList={false} beforeUpload={(file) => { handleFile(file as File); return false; }}>
              <p className="ant-upload-drag-icon">{importing ? <ReloadOutlined spin /> : <InboxOutlined />}</p>
              <p className="ant-upload-text">{t('users.uploadText')}</p>
              <p className="ant-upload-hint">{t('users.uploadHint')}</p>
            </Upload.Dragger>
            <Divider plain>{t('users.orPaste')}</Divider>
            <Input.TextArea rows={4} placeholder={t('users.pastePlaceholder')} value={csvText} onChange={(e) => setCsvText(e.target.value)} />
            <div style={{ marginTop: 8, textAlign: 'right' }}>
              <Button type="primary" icon={<ImportOutlined />} loading={importing} disabled={!csvText.trim()} onClick={pasteImport}>{t('users.pastePreview')}</Button>
            </div>
          </div>
        )}
        {importStep === 2 && preview && (
          <div>
            {(() => {
              const statusNote = (preview.activated > 0 || preview.deactivated > 0)
                ? t('users.previewStatus', { activated: preview.activated, deactivated: preview.deactivated })
                : '';
              const base = t('users.previewBase', { total: preview.total, created: preview.created }) + statusNote;
              return preview.skipped.length > 0
                ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={base + t('users.previewSkipped', { count: preview.skipped.length })} />
                : <Alert type="success" showIcon style={{ marginBottom: 12 }} message={base} />;
            })()}
            {preview.unknownCols.length > 0 && (
              <Alert type="info" showIcon style={{ marginBottom: 12 }} message={t('users.unknownCols', { cols: preview.unknownCols.join('、') })} />
            )}
            {preview.skipped.length > 0 ? (
              <Table size="small" rowKey="row" pagination={{ pageSize: 8 }} dataSource={preview.skipped}
                columns={[{ title: t('users.rowNo'), dataIndex: 'row', width: 80 }, { title: t('users.reason'), dataIndex: 'reason' }]} />
            ) : <Empty description={t('users.allImportable')} />}
            <div style={{ marginTop: 16, textAlign: 'right' }}>
              <Space>
                <Button onClick={() => setImportStep(1)}>{t('history.back')}</Button>
                <Button type="primary" loading={importing} onClick={doCommit}>{t('users.confirmImport')}</Button>
              </Space>
            </div>
          </div>
        )}
        {importStep === 3 && importResult && (
          <Result
            status={importResult.skipped.length ? 'warning' : 'success'}
            title={t('users.importDoneTitle')}
            extra={[
              importResult.skipped.length > 0 && (
                <Alert key="sk" type="warning" showIcon style={{ marginBottom: 12 }} message={t('users.skippedDetail', { count: importResult.skipped.length })} />
              ),
              importResult.skipped.length > 0 && (
                <Table key="t" size="small" rowKey="row" pagination={{ pageSize: 6 }} dataSource={importResult.skipped}
                  columns={[{ title: t('users.rowNo'), dataIndex: 'row', width: 80 }, { title: t('users.reason'), dataIndex: 'reason' }]} />
              ),
              <Button key="ok" type="primary" onClick={() => setImportOpen(false)}>{t('users.done')}</Button>,
            ]}
          />
        )}
      </Modal>
      <Table rowKey="id" size="small" loading={loading} columns={cols} dataSource={users}
        pagination={{ pageSize: 10 }} scroll={{ x: 'max-content' }}
        components={{ header: { cell: ResizableTitle } }}
        onChange={(_p: any, _f: any, sorter: any) => {
          // 2026-08-11：列头排序 → 更新排序状态（触发 load）；无排序 → 恢复默认工号升序
          const s = Array.isArray(sorter) ? sorter[0] : sorter;
          setSortState(s?.field ? { field: s.field, order: s.order ?? undefined } : { field: 'employee_no', order: 'ascend' });
        }} />

      <Modal
        title={editing ? t('users.editTitle', { name: editing.name }) : t('users.createTitle')} open={modalOpen}
        onOk={submit} confirmLoading={saving} onCancel={() => setModalOpen(false)} width={520}
      >
        <Form form={form} layout="vertical">
          <Space size="middle" style={{ display: 'flex' }}>
            <Form.Item name="employee_no" label={t('users.fEmployeeNo')} rules={[{ required: true, message: t('users.employeeNoRequired') }]} style={{ flex: 1 }}>
              <Input placeholder={t('users.employeeNoPlaceholder')} />
            </Form.Item>
            <Form.Item name="name" label={t('users.fName')} rules={[{ required: true, message: t('users.nameRequired') }]} style={{ flex: 1 }}>
              <Input />
            </Form.Item>
          </Space>
          <Space size="middle" style={{ display: 'flex' }}>
            <Form.Item name="region" label={t('users.fRegion')} rules={reqRule('region', t('users.selectRegion'))} style={{ flex: 1 }}>
              <Select showSearch optionFilterProp="label" placeholder={t('users.selectRegion')} options={optOf('region')} />
            </Form.Item>
            <Form.Item name="contract_type" label={t('users.fContractType')} rules={reqRule('contract_type', t('users.selectContractType'))} style={{ flex: 1 }}>
              <Select showSearch optionFilterProp="label" placeholder={t('users.selectContractType')} options={optOf('contract_type')} />
            </Form.Item>
            <Form.Item name="level_type" label={t('users.fLevelType')} rules={reqRule('level_type', t('users.selectLevelType'))} style={{ flex: 1 }}>
              <Select showSearch optionFilterProp="label" placeholder={t('users.selectLevelType')} options={optOf('level_type')} />
            </Form.Item>
          </Space>
          <Row gutter={16}>
            <Col span={12}><Form.Item name="department" label={t('users.fDepartment')} style={{ marginBottom: 16 }}><Select allowClear showSearch optionFilterProp="label" placeholder={t('users.searchDept')} style={{ width: '100%' }} options={optOf('department')} /></Form.Item></Col>
          </Row>
          <Space size="middle" style={{ display: 'flex' }}>
            <Form.Item name="email" label={t('users.fEmail')} style={{ flex: 1 }}><Input /></Form.Item>
            <Form.Item name="phone" label={t('users.fPhone')} style={{ flex: 1 }}><Input /></Form.Item>
          </Space>
          <Form.Item name="position" label={t('users.fPosition')} style={{ marginBottom: 0 }}><Select allowClear showSearch optionFilterProp="label" placeholder={t('users.searchPosition')} style={{ width: '100%' }} options={optOf('position')} /></Form.Item>
          {/* 2026-08-11：预留自定义字段（option→单选 / multi→多选 / text→输入框） */}
          {customFields.length > 0 && (
            <Divider style={{ margin: '12px 0' }} />
          )}
          {customFields.map((f) => (
            f.type === 'text' ? (
              <Form.Item key={f.key} name={f.key} label={fieldName(f)} style={{ flex: 1, marginBottom: 12 }}
                rules={f.required ? [{ required: true, message: t('users.fillField', { name: fieldName(f) }) }] : []}>
                <Input placeholder={t('users.fillFieldPlaceholder', { name: fieldName(f) })} />
              </Form.Item>
            ) : (
              <Form.Item key={f.key} name={f.key} label={fieldName(f)} style={{ flex: 1, marginBottom: 12 }}
                rules={f.required ? [{ required: true, message: t('users.selectField', { name: fieldName(f) }) }] : []}>
                <Select allowClear showSearch optionFilterProp="label" placeholder={t('users.selectFieldPlaceholder', { name: fieldName(f) })} mode={f.type === 'multi' ? 'multiple' : undefined} options={optOf(f.key)} />
              </Form.Item>
            )
          ))}
          {editing && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('users.saveHint')}</Typography.Text>}
        </Form>
      </Modal>
      </div>
    </div>
  );
}
