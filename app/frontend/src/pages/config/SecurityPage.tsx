// 安全设置页（2026-08-12，PRD §4.5.4）——密级体系（档位+策略矩阵，安全设置页独立管理）/ 阅读保护（全局）/ 审计日志
// 与问答配置、用户属性同层级（系统配置子菜单，config_mgmt 权限）
// 2026-08-12 修正：密级档位独立管理（app_configs.security.levels），不放入用户属性 field_dicts（避免语义错位 + 规则编辑器字段污染）
// 2026-08-12 表格风格对齐用户属性页：倒数第二列=状态 Tag；启用/停用、删除折叠进「更多」（非常用操作）；档位键创建后只读；排序用上移/下移
import { useEffect, useState } from 'react';
import { App, Alert, Button, Card, Dropdown, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { PlusOutlined, MoreOutlined, ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { authFetch } from '../../lib/api';

interface Level { value: string; label: string; label_en?: string | null; sort: number; enabled: boolean; in_use?: number }
interface PolicyEntry { watermark: boolean; copy_protect: boolean; ai_searchable: boolean; audit_read: boolean; audit_denied: boolean }
type Policy = Record<string, PolicyEntry>;

const BEHAVIORS: { key: keyof PolicyEntry; label: string; hint: string }[] = [
  { key: 'watermark', label: '浏览水印', hint: '阅读页加水印（用户名+工号+时间）' },
  { key: 'copy_protect', label: '禁止复制', hint: '禁复制/右键/截图（阅读页）' },
  { key: 'ai_searchable', label: 'AI 可检索', hint: '可被问答检索引用；关闭=人可读但 AI 一律不引用' },
  { key: 'audit_read', label: '浏览审计', hint: '谁读过 → 记审计日志' },
];
const BEHAVIOR_KEY: Record<string, string> = { watermark: 'security.behavior.watermark', copy_protect: 'security.behavior.copy_protect', ai_searchable: 'security.behavior.ai_searchable', audit_read: 'security.behavior.audit_read' };
const BEHAVIOR_HINT_KEY: Record<string, string> = { watermark: 'security.behaviorHint.watermark', copy_protect: 'security.behaviorHint.copy_protect', ai_searchable: 'security.behaviorHint.ai_searchable', audit_read: 'security.behaviorHint.audit_read' };

const DEFAULT_ENTRY: PolicyEntry = { watermark: false, copy_protect: false, ai_searchable: true, audit_read: false, audit_denied: false };

export default function SecurityPage() {
  const { message, modal } = App.useApp();
  const { t } = useTranslation();
  const [levels, setLevels] = useState<Level[]>([]);
  const [policy, setPolicy] = useState<Policy>({});
  const [wm, setWm] = useState(true);
  const [cp, setCp] = useState(true);
  const [fc, setFc] = useState(true); // 2026-08-13：首次登录强制改密（安全入口收敛，从问答配置移入）
  const [auditDir, setAuditDir] = useState('');
  const [files, setFiles] = useState<{ name: string; size: number; mtime: string }[]>([]);
  // 日志查看器
  const [curFile, setCurFile] = useState('');
  const [logRows, setLogRows] = useState<{ ts: string; action: string; userId: string | null; userName: string | null; employeeNo: string | null; lineName: string | null; security_level: string | null; detail: string }[]>([]);
  const [logAction, setLogAction] = useState('');
  const [logUser, setLogUser] = useState('');
  const [logLoading, setLogLoading] = useState(false);
  // 新增档位弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm();

  const load = async () => {
    try {
      const [c, f] = await Promise.all([
        authFetch('/api/security/config').then((r) => r.json()),
        authFetch('/api/security/audit-files').then((r) => r.json()),
      ]);
      setLevels(c.levels ?? []);
      setPolicy(c.policy ?? {});
      setWm((c.watermark_enabled ?? '1') !== '0');
      setCp((c.copy_protect_enabled ?? '1') !== '0');
      setFc((c.force_change_on_first_login ?? '0') !== '0');
      setAuditDir(c.audit_dir ?? '');
      setFiles(f.files ?? []);
    } catch { message.error(t('security.loadFailed')); }
  };
  useEffect(() => { load(); }, []);

  // 保存：档位 + 策略矩阵（一体提交）
  const saveAll = async () => {
    setSaving(true);
    try {
      if (!levels.length) throw new Error(t('security.atLeastOne'));
      if (levels.some((l) => !l.value.trim() || !l.label.trim())) throw new Error(t('security.keyLabelRequired'));
      const seen = new Set(levels.map((l) => l.value));
      if (seen.size !== levels.length) throw new Error(t('security.keyDuplicate'));
      const r1 = await authFetch('/api/security/levels', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ levels }) });
      if (!r1.ok) { const e = await r1.json().catch(() => ({})); throw new Error(e.error ?? t('security.levelsSaveFailed')); }
      const r2 = await authFetch('/api/security/policy', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ policy }) });
      if (!r2.ok) { const e = await r2.json().catch(() => ({})); throw new Error(e.error ?? t('security.policySaveFailed')); }
      message.success(t('security.saved'));
    } catch (e: any) { message.error(t('config.saveFailed', { msg: e?.message ?? '' })); } finally { setSaving(false); }
  };
  const [saving, setSaving] = useState(false);

  const saveGlobal = async (key: string, val: boolean) => {
    try {
      const r = await authFetch(`/api/configs/${key}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: val ? '1' : '0' }) });
      if (!r.ok) throw new Error('save-fail');
      message.success(t('dict.saved'));
    } catch { message.error(t('config.saveFailed', { msg: '' })); }
  };

  // 新增档位（Modal：键+名称；创建后键只读不可改）
  const createLevel = async () => {
    const v = await createForm.validateFields().catch(() => null);
    if (!v) return;
    const value = String(v.value ?? '').trim();
    if (levels.some((l) => l.value === value)) { message.error(t('security.keyExists')); return; }
    setLevels([...levels, { value, label: String(v.label ?? value).trim(), label_en: v.label_en?.trim() || null, sort: Math.max(...levels.map((l) => l.sort), -1) + 1, enabled: true }]);
    setPolicy((p) => ({ ...p, [value]: { ...DEFAULT_ENTRY } }));
    createForm.resetFields(); setCreateOpen(false);
  };

  const updateLevel = (value: string, patch: Partial<Level>) => setLevels((ls) => ls.map((l) => (l.value === value ? { ...l, ...patch } : l)));
  const toggleEnabled = (value: string) => setLevels((ls) => ls.map((l) => (l.value === value ? { ...l, enabled: !l.enabled } : l)));
  const removeLevel = (value: string) => {
    setLevels((ls) => ls.filter((l) => l.value !== value));
    setPolicy((p) => { const { [value]: _, ...rest } = p; return rest; });
  };
  const moveLevel = (value: string, dir: -1 | 1) => {
    const sorted = [...levels].sort((a, b) => a.sort - b.sort || String(a.label).localeCompare(String(b.label), 'zh'));
    const idx = sorted.findIndex((l) => l.value === value);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= sorted.length) return;
    const next = [...sorted];
    [next[idx], next[j]] = [next[j], next[idx]];
    setLevels(next.map((l, i) => ({ ...l, sort: i })));
  };
  const setEntry = (level: string, key: keyof PolicyEntry, val: boolean) =>
    setPolicy((p) => ({ ...p, [level]: { ...(p[level] ?? DEFAULT_ENTRY), [key]: val } }));

  const fmtSize = (n: number) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B');

  // 加载某天日志内容
  const loadLog = async (file: string) => {
    if (!file) return;
    setCurFile(file); setLogLoading(true);
    try {
      const q = new URLSearchParams({ file, limit: '300' });
      if (logAction) q.set('action', logAction);
      if (logUser) q.set('user', logUser);
      const r = await authFetch(`/api/security/audit-log?${q}`).then((x) => x.json());
      setLogRows(r.rows ?? []);
    } catch { setLogRows([]); message.error('加载日志失败'); } finally { setLogLoading(false); }
  };
  useEffect(() => { if (files.length && !curFile) loadLog(files[0].name); }, [files]);

  const ACTION_LABEL: Record<string, string> = {
    read_policy: t('security.action.read_policy'), read_policy_denied: t('security.action.read_policy_denied'), login: t('security.action.login'), logout: t('security.action.logout'),
    publish: t('security.action.publish'), edit_line_visibility: t('security.action.edit_line_visibility'), feedback: t('security.action.feedback'), save_security_policy: t('security.action.save_security_policy'), save_security_levels: t('security.action.save_security_levels'),
  };

  const levelTableData = [...levels].sort((a, b) => a.sort - b.sort || String(a.label).localeCompare(String(b.label), 'zh'));

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 4 }}>{t('console.configSecurity')}</h2>
      <Typography.Text type="secondary">{t('security.subtitle')}</Typography.Text>

      {/* ① 密级体系：档位 + 策略矩阵（一体） */}
      <Card title={t('security.levelsTitle')} style={{ marginTop: 16 }}
        extra={<Space><Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>{t('security.addLevel')}</Button><Button onClick={saveAll} loading={saving}>{t('security.saveLevels')}</Button></Space>}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {t('security.levelsHint')}
        </Typography.Paragraph>
        <Table rowKey="value" size="small" pagination={false} dataSource={levelTableData}
          columns={[
            { title: t('security.colKey'), dataIndex: 'value', width: 130, render: (v, r) => <Typography.Text code style={{ fontSize: 12 }}>{v}</Typography.Text> },
            { title: t('security.colName'), width: 130, render: (_, r) => <Input size="small" value={r.label} onChange={(e) => updateLevel(r.value, { label: e.target.value })} /> },
            { title: t('security.colNameEn'), width: 140, render: (_, r) => <Input size="small" value={r.label_en ?? ''} placeholder={t('fieldDicts.optLabelEnPh')} onChange={(e) => updateLevel(r.value, { label_en: e.target.value })} /> },
            { title: t('security.colSort'), width: 86, align: 'center' as const, render: (_, r) => (
              <Space size={2}>
                <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={levelTableData[0]?.value === r.value} onClick={() => moveLevel(r.value, -1)} />
                <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={levelTableData[levelTableData.length - 1]?.value === r.value} onClick={() => moveLevel(r.value, 1)} />
              </Space>
            ) },
            ...BEHAVIORS.map((b) => ({
              title: (<span title={t(BEHAVIOR_HINT_KEY[b.key])}>{t(BEHAVIOR_KEY[b.key])}</span>), width: 96, align: 'center' as const,
              render: (_: any, r: Level) => (
                <Switch size="small" checked={policy[r.value]?.[b.key] ?? (b.key === 'ai_searchable')}
                  onChange={(v) => setEntry(r.value, b.key, v)} />
              ),
            })),
            // 倒数第二列：状态（与用户属性页风格一致）
            { title: t('security.colStatus'), width: 80, align: 'center' as const, render: (_, r) => <Tag color={r.enabled ? 'green' : 'default'}>{r.enabled ? t('users.enabled') : t('users.disabled')}</Tag> },
            // 最后一列：操作（启用/停用、删除折叠进「更多」，非常用操作——与用户属性一致）
            { title: t('security.colOp'), width: 60, render: (_, r) => (
              <Dropdown trigger={['click']} menu={{ items: [
                { key: 'toggle', label: r.enabled ? t('users.disabled') : t('users.enabled'), onClick: () => toggleEnabled(r.value) },
                { key: 'delete', label: t('users.deleteOk'), danger: true, disabled: !!r.in_use, onClick: () => modal.confirm({ title: t('security.deleteLevelTitle', { name: r.label }), content: r.in_use ? t('security.deleteLevelInUse') : t('security.deleteLevelConfirm'), okText: t('users.deleteOk'), okButtonProps: { danger: true }, cancelText: t('action.cancel'), onOk: () => removeLevel(r.value) }) },
              ] }}>
                <Button size="small" type="link" icon={<MoreOutlined />} style={{ padding: '0 6px' }} />
              </Dropdown>
            ) },
          ]}
        />
        <Alert style={{ marginTop: 12 }} type="info" showIcon message={t('security.aiSearchableTitle')}
          description={t('security.aiSearchableDesc')} />
        <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)', marginTop: 8, lineHeight: 1.7 }} dangerouslySetInnerHTML={{ __html: t('security.auditReadNote') }} />
      </Card>

      {/* 新增档位弹窗（键创建后不可改） */}
      <Modal title={t('security.createLevelTitle')} open={createOpen} onOk={createLevel} onCancel={() => setCreateOpen(false)} okText={t('admin.createOk')} cancelText={t('action.cancel')} width={420}>
        <Form form={createForm} layout="vertical">
          <Form.Item name="value" label={t('security.keyLabel')} rules={[{ required: true, message: t('security.keyRequired') }, { pattern: /^[a-zA-Z0-9_-]+$/, message: t('security.keyPattern') }]}>
            <Input placeholder={t('security.keyPlaceholder')} />
          </Form.Item>
          <Form.Item name="label" label={t('security.nameLabel')} rules={[{ required: true, message: t('security.nameRequired') }]}>
            <Input placeholder={t('security.namePlaceholder')} />
          </Form.Item>
          <Form.Item name="label_en" label={t('security.nameEnLabel')}>
            <Input placeholder={t('security.nameEnPlaceholder')} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ② 阅读保护全局 */}
      <Card title={t('security.readProtectTitle')} style={{ marginTop: 16 }}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div><Switch checked={wm} onChange={(v) => { setWm(v); saveGlobal('common.security.watermark_enabled', v); }} /> <span style={{ marginLeft: 8 }}>{t('security.watermarkGlobal')}</span></div>
          <div><Switch checked={cp} onChange={(v) => { setCp(v); saveGlobal('common.security.copy_protect_enabled', v); }} /> <span style={{ marginLeft: 8 }}>{t('security.copyProtectGlobal')}</span></div>
        </Space>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
          {t('security.readProtectNote')}
        </Typography.Paragraph>
      </Card>

      {/* ③ 登录安全（2026-08-13：安全入口收敛——首次登录强制改密从问答配置移至此处，安全设置页为唯一入口） */}
      <Card title={t('security.loginSecurityTitle')} style={{ marginTop: 16 }}>
        <div><Switch checked={fc} onChange={(v) => { setFc(v); saveGlobal('common.security.force_change_on_first_login', v); }} /> <span style={{ marginLeft: 8 }}>{t('security.forceChangeGlobal')}</span></div>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
          {t('security.forceChangeNote')}
        </Typography.Paragraph>
      </Card>

      {/* ④ 审计日志查看器 */}
      <Card title={t('security.auditTitle')} style={{ marginTop: 16 }}>
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          {t('security.auditDir')}<Typography.Text code copyable>{auditDir || 'data/logs/audit/'}</Typography.Text>
        </Typography.Paragraph>
        <Space style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <Select size="small" style={{ width: 180 }} value={curFile} onChange={loadLog} options={files.map((f) => ({ value: f.name, label: `${f.name}（${fmtSize(f.size)}）` }))} />
          <Select size="small" allowClear placeholder={t('security.filterAction')} style={{ width: 150 }} value={logAction || undefined}
            onChange={(v) => { setLogAction(v ?? ''); loadLog(curFile); }}
            options={Object.entries(ACTION_LABEL).map(([v, l]) => ({ value: v, label: l }))} />
          <Input size="small" placeholder={t('security.filterUser')} style={{ width: 140 }} value={logUser}
            onChange={(e) => setLogUser(e.target.value)} onPressEnter={() => loadLog(curFile)} />
          <Button size="small" onClick={() => loadLog(curFile)}>{t('security.query')}</Button>
        </Space>
        <Table rowKey={(r) => r.ts + r.action + Math.random()} size="small" loading={logLoading} dataSource={logRows} pagination={{ pageSize: 20, showSizeChanger: false }}
          columns={[
            { title: t('security.colTime'), dataIndex: 'ts', width: 190, render: (v: string) => new Date(v).toLocaleString() },
            { title: t('security.colAction'), dataIndex: 'action', width: 110, render: (v: string) => <Tag color={v === 'read_policy_denied' ? 'red' : v === 'read_policy' ? 'blue' : undefined}>{ACTION_LABEL[v] ?? v}</Tag> },
            { title: t('security.colUser'), width: 140, render: (_, r) => r.userName ? <span>{r.userName}{r.employeeNo ? `（${r.employeeNo}）` : ''}</span> : (r.userId ?? t('security.anonymous')) },
            { title: t('security.colTarget'), width: 200, render: (_, r) => {
              const lvLabel = levels.find((l) => l.value === r.security_level)?.label ?? r.security_level;
              return r.lineName ? <span>{r.lineName}{r.security_level && <Tag style={{ marginLeft: 6 }} color={r.security_level === 'top_secret' ? 'magenta' : r.security_level === 'confidential' ? 'red' : undefined}>{lvLabel}</Tag>}</span> : '-';
            } },
            { title: t('security.colDetail'), dataIndex: 'detail', ellipsis: true },
          ]} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('security.auditNote')}
        </Typography.Text>
      </Card>
    </div>
  );
}
