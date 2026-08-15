// 权限角色管理（S6 权限，PRD §3.3；2026-08-07 简化：废弃 dynamic/manual 类型）
// 组 = 规则（可选，自动入组）+ 包含成员 + 排除成员；判定 = (规则自动 ∪ 包含) − 排除
// UI：规则区 / 排除成员区 / 包含成员区（成员用搜索选择器）；"查看最新成员名单"弹框
import { useEffect, useState } from 'react';
import { App, Button, Checkbox, Dropdown, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined, TeamOutlined, MoreOutlined, EyeOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { Groups, Libraries, Users, type GroupRow, type GroupRule } from '../lib/policy-api';
import { api } from '../lib/api';
import { isZhUI } from '../i18n';
import ConditionEditor from '../components/ConditionEditor';
import { ResizableTitle } from '../components/table/ResizableTitle';
import { useColPrefs, colVisible, colWidth } from '../components/table/useColPrefs';
import ColumnSettings from '../components/table/ColumnSettings';

const FIELD_OPTIONS = [
  { field: 'region', label: '地区', values: ['中国北京', '中国深圳', '美国加州'] },
  { field: 'contract_type', label: '合同类型', values: ['正式', '实习', '外包'] },
  { field: 'level_type', label: '层级', values: ['高管', '管理者', 'IC'] },
  { field: 'department', label: '部门', values: ['人力资源部', '技术部', '销售部', '制造部', '财务部', '行政部', '市场部'] },
  { field: 'position', label: '岗位', values: ['经理', '主管', '专员', '工程师', '分析师', '销售代表', 'HR专员', '财务专员'] },
];
const FIELD_LABEL_KEY: Record<string, string> = { region: 'groups.fieldRegion', contract_type: 'groups.fieldContractType', level_type: 'groups.fieldLevelType', department: 'groups.fieldDepartment', position: 'groups.fieldPosition' };
const TYPE_LABEL: Record<string, string> = { builtin: '内置组' };

interface Member { id: string; name: string; employee_no: string | null; department?: string | null; position?: string | null }

export default function GroupsPage() {
  const { message, modal } = App.useApp();
  const { t } = useTranslation();
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [loading, setLoading] = useState(false);
  // 2026-08-11：列表组名搜索 + 状态过滤（控件样式与用户管理页一致）
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [editing, setEditing] = useState<GroupRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [users, setUsers] = useState<Member[]>([]);
  const [form] = Form.useForm();
  // 条件编辑草稿（2026-08-07 修复：透传 operator in/not_in——此前类型/加载/保存三处丢弃，前端配"不包含"会静默变"包含"）
  const [rules, setRules] = useState<{ rule_no: number; conditions: { field: string; operator?: 'in' | 'not_in'; values: string[] }[] }[]>([]);
  // 方案 B：功能勾选 + 管理范围
  const [functionIds, setFunctionIds] = useState<string[]>([]);
  const [managedLibs, setManagedLibs] = useState<string[]>([]);
  const [allLibs, setAllLibs] = useState<{ id: string; name: string }[]>([]);
  // 2026-08-13：字段选项 label 映射（en 显示 label_en）——规则文本展示用
  const [optLabelMap, setOptLabelMap] = useState<Record<string, Record<string, string>>>({});
  const FUNCTIONS = [
    { key: 'config_mgmt', label: t('groups.fnConfig') },
    { key: 'role_mgmt', label: t('groups.fnRole') },
    { key: 'user_mgmt', label: t('groups.fnUser') },
    { key: 'stats_view', label: t('groups.fnStats') },
    { key: 'policy_library_mgmt', label: t('groups.fnLibGlobal') },
    { key: 'policy_mgmt', label: t('groups.fnLibContent') },
  ];
  // 例外成员草稿（include / exclude）
  const [includeM, setIncludeM] = useState<Member[]>([]);
  const [excludeM, setExcludeM] = useState<Member[]>([]);

  // 最新成员名单弹框
  const [viewMembers, setViewMembers] = useState<{ group: GroupRow; q: string } | null>(null);

  const load = async () => {
    setLoading(true);
    try { const { groups: list } = await Groups.list(); setGroups(list); } catch (e: any) { message.error(t('groups.loadFailed', { msg: e?.message ?? e })); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); Libraries.list().then((d) => setAllLibs((d.libraries ?? []).filter((l: any) => l.status === 'active').map((l: any) => ({ id: l.id, name: l.name })))).catch(() => {}); Users.list({ status: 'active' }).then(({ users: list }) => setUsers(list.map((u) => ({ id: u.id, name: u.name, employee_no: u.employee_no, department: u.department, position: u.position })))).catch(() => {}); api.get('/field_dicts').then((r) => { const m: Record<string, Record<string, string>> = {}; for (const f of r.data?.fields ?? []) { m[f.key] = {}; for (const o of f.options ?? []) m[f.key][o.value] = isZhUI() ? o.label : (o.label_en || o.label); } setOptLabelMap(m); }).catch(() => {}); }, []);

  const openCreate = () => {
    setEditing(null); form.resetFields();
    setRules([]); setIncludeM([]); setExcludeM([]); setFunctionIds([]); setManagedLibs([]);
    setModalOpen(true);
  };
  const openEdit = (g: GroupRow) => {
    setEditing(g);
    form.setFieldsValue({ name: g.name, description: g.description });
    const byNo = new Map<number, GroupRule[]>();
    for (const r of g.rules ?? []) { const arr = byNo.get(r.rule_no) ?? []; arr.push(r); byNo.set(r.rule_no, arr); }
    setRules([...byNo.entries()].map(([no, conds]) => ({ rule_no: no, conditions: conds.map((c) => ({ field: c.field, operator: c.operator, values: c.values })) })));
    setIncludeM((g as any).include_members ?? []);
    setExcludeM((g as any).exclude_members ?? []);
    setFunctionIds(g.function_ids ?? []);
    setManagedLibs(g.managed_library_ids ?? []);
    setModalOpen(true);
  };

  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      let gid = editing?.id;
      if (editing) await Groups.update(editing.id, { name: v.name, description: v.description ?? null, function_ids: functionIds, managed_library_ids: managedLibs });
      else { const c = await Groups.create({ name: v.name, description: v.description }); gid = c.id; await Groups.update(c.id, { function_ids: functionIds, managed_library_ids: managedLibs }); }
      if (gid && rules.length) await Groups.saveRules(gid, rules.flatMap((r) => r.conditions.map((c) => ({ rule_no: r.rule_no, field: c.field, operator: c.operator, values: c.values }))));
      if (gid) {
        // diff 式成员保存（2026-08-07 修复：此前只 addMember 不删除——移除成员不生效）：
        // 先删被移除的（当前有但新列表没有），再加新增的；include/exclude 类型变化由 changeMembers 互斥保证
        const curG = groups.find((x) => x.id === gid);
        const curInc = new Set((curG?.include_members ?? []).map((m) => m.id));
        const curExc = new Set((curG?.exclude_members ?? []).map((m) => m.id));
        const nextInc = new Set(includeM.map((m) => m.id));
        const nextExc = new Set(excludeM.map((m) => m.id));
        for (const id of curInc) if (!nextInc.has(id) && !nextExc.has(id)) await Groups.removeMember(gid, id);
        for (const id of curExc) if (!nextExc.has(id) && !nextInc.has(id)) await Groups.removeMember(gid, id);
        for (const m of includeM) if (!curInc.has(m.id)) await Groups.addMember(gid, m.id, 'include');
        for (const m of excludeM) if (!curExc.has(m.id)) await Groups.addMember(gid, m.id, 'exclude');
      }
      message.success(t('groups.saved')); setModalOpen(false); load();
    } catch (e: any) { message.error(e?.response?.data?.error ?? String(e?.message ?? e)); }
    finally { setSaving(false); }
  };

  // 成员多选 Select（本地 state 草稿，submit 时 diff 保存）
  const changeMembers = (type: 'include' | 'exclude', ids: string[]) => {
    const upd = (ids: string[]): Member[] => ids.map((id) => users.find((u) => u.id === id)).filter(Boolean) as Member[];
    if (type === 'include') {
      setIncludeM(upd(ids));
      // 互斥：包含中出现的，从排除移除
      setExcludeM((prev) => prev.filter((m) => !ids.includes(m.id)));
    } else {
      setExcludeM(upd(ids));
      setIncludeM((prev) => prev.filter((m) => !ids.includes(m.id)));
    }
  };
  // 成员 Select 的选项：已选（保证 label 显示）+ 远程搜索结果（排除已选）
  const memberOptions = (type: 'include' | 'exclude'): { value: string; label: string }[] => {
    const other = type === 'include' ? excludeM : includeM;
    const otherIds = new Set(other.map((m) => m.id));
    // 全部启用用户（本地过滤可搜索；已选成员保留在选项里保证 label 显示）
    return users
      .filter((u) => !otherIds.has(u.id))
      .map((u) => ({ value: u.id, label: `${u.name}（${u.employee_no ?? '-'}） ${u.department ?? ''}-${u.position ?? ''}` }));
  };
  const memberValue = (type: 'include' | 'exclude') => (type === 'include' ? includeM : excludeM).map((m) => m.id);
  // 成员选择器组件（远程搜索多选）
  const MemberSelect = ({ type, label }: { type: 'include' | 'exclude'; label: string }) => (
    <Select
      mode="multiple" showSearch allowClear optionFilterProp="label" style={{ width: '100%' }}
      placeholder={t('groups.memberSearch', { label })}
      value={memberValue(type)} onChange={(ids: string[]) => changeMembers(type, ids)}
      options={memberOptions(type)}
    />
  );

  // 成员多选 Select（本地 state 草稿，submit 时 diff 保存）
  // 2026-08-11：列设置 + 拖宽（公共组件，个人偏好 localStorage）
  const { colPrefs, setColWidth, toggleCol, resetCols } = useColPrefs('groupsPageColPrefs');
  const allDefs = [
    { key: 'name', title: t('groups.colName'), width: 180 },
    { key: 'rule', title: t('groups.colRule'), width: 280 },
    { key: 'members', title: t('groups.colMembers'), width: 280 },
    { key: 'status', title: t('users.colStatus'), width: 80 },
    { key: 'op', title: t('users.colOp'), width: 160 },
  ];
  // 列渲染器（2026-08-11：按钮风格统一——常用 link、非常用折叠「⋯」、停用/删除 modal.confirm）
  const renderers: Record<string, any> = {
    name: (v: string, g: GroupRow) => (<Space><TeamOutlined />{v} {g.type === 'builtin' && <Tag color="blue">{t('groups.builtin')}</Tag>}</Space>),
    rule: (_: unknown, g: GroupRow) => {
      if (!(g.rules ?? []).length) return <Typography.Text type="secondary">—</Typography.Text>;
      const byNo = new Map<number, GroupRule[]>();
      for (const r of g.rules!) { const arr = byNo.get(r.rule_no) ?? []; arr.push(r); byNo.set(r.rule_no, arr); }
      const text = [...byNo.entries()].map(([no, conds]) => conds.map((c) => `${t(FIELD_LABEL_KEY[c.field] ?? c.field, { defaultValue: c.field })} ∈ {${c.values.map((v) => optLabelMap[c.field]?.[v] ?? v).join(',')}}`).join(' 且 ')).join(' 或 ');
      return <Typography.Text type="secondary" style={{ fontSize: 12 }}>{text}</Typography.Text>;
    },
    members: (_: unknown, g: GroupRow) => {
      const ms = g.members ?? [];
      const ex = (g as any).exclude_members ?? [];
      if (!ms.length) return <Typography.Text type="secondary">—</Typography.Text>;
      return (
        <Space size="small" wrap>
          <span style={{ fontSize: 12 }}>{ms.slice(0, 3).map((m) => `${m.name}（${m.department ?? '-'}·${m.position ?? '-'}）`).join('、')}{ms.length > 3 ? '…' : ''}</span>
          {ex.length > 0 && <Tag color="red">{t('groups.excluded', { count: ex.length })}</Tag>}
          <Button size="small" type="link" onClick={() => setViewMembers({ group: g, q: '' })}>{t('groups.memberList', { count: ms.length })}</Button>
        </Space>
      );
    },
    status: (v: number) => (v ? <Tag color="green">{t('users.enabled')}</Tag> : <Tag>{t('users.disabled')}</Tag>),
    op: (_: unknown, g: GroupRow) => (
      <Space size="small">
        <Button size="small" type="link" onClick={() => openEdit(g)}>{t('dict.edit')}</Button>
        {g.type !== 'builtin' ? (
          <Dropdown trigger={['click']}
            menu={{ items: [
              { key: 'toggle', label: g.enabled ? t('users.disabled') : t('users.enabled'), onClick: () => modal.confirm({
                title: g.enabled ? t('groups.toggleConfirmTitle', { name: g.name }) : t('groups.enableConfirmTitle', { name: g.name }),
                content: g.enabled ? t('groups.toggleContent') : undefined,
                okText: g.enabled ? t('users.disabled') : t('users.enabled'), okButtonProps: g.enabled ? { danger: true } : undefined, cancelText: t('action.cancel'),
                onOk: async () => { try { await Groups.update(g.id, { enabled: g.enabled ? 0 : 1 }); message.success(g.enabled ? t('groups.deactivated') : t('groups.activated')); load(); } catch { message.error(t('groups.opsFailed')); } },
              }) },
              { key: 'delete', label: t('users.deleteOk'), danger: true, onClick: () => modal.confirm({
                title: t('groups.deleteConfirmTitle', { name: g.name }),
                content: t('groups.deleteConfirmContent'),
                okText: t('users.deleteOk'), okButtonProps: { danger: true }, cancelText: t('action.cancel'),
                onOk: async () => { try { await Groups.remove(g.id); message.success(t('groups.deleted')); load(); } catch (e: any) { message.error(e?.response?.data?.error ?? t('groups.deleteFailed')); } },
              }) },
            ] }}>
            <Button size="small" type="text" icon={<MoreOutlined />} />
          </Dropdown>
        ) : <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('groups.builtin')}</Typography.Text>}
      </Space>
    ),
  };

  const cols = allDefs
    .filter((c) => colVisible(colPrefs, c.key))
    .map((c) => {
      const w = colWidth(colPrefs, c.key, c.width);
      const col: any = { key: c.key, title: c.title, width: w, render: renderers[c.key] };
      if (c.key === 'name') col.dataIndex = 'name';
      if (c.key === 'status') col.dataIndex = 'enabled';
      // 组名排序（组数少全量加载，前端排序即可）
      if (c.key === 'name') col.sorter = (a: GroupRow, b: GroupRow) => String(a.name).localeCompare(String(b.name), 'zh');
      col.onHeaderCell = () => ({ width: w, onResize: (nw: number) => setColWidth(c.key, nw) });
      return col;
    });
  // 2026-08-11：组名搜索 + 状态过滤（enabled: 0/1）
  const filteredGroups = groups.filter((g) =>
    (!query.trim() || g.name.includes(query.trim())) &&
    (!statusFilter || (statusFilter === 'active' ? g.enabled === 1 : g.enabled === 0)),
  );

  return (
    <div className="admin-page" style={{ padding: 24, height: 'calc(100vh - 52px)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <Typography.Title level={4} style={{ margin: 0, marginBottom: 16, flexShrink: 0 }}>{t('console.groups')}</Typography.Title>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search placeholder={t('groups.searchPlaceholder')} allowClear style={{ width: 220 }} onSearch={setQuery} />
        <Select
          placeholder={t('users.statusPlaceholder')} allowClear style={{ width: 110 }}
          value={statusFilter || undefined} onChange={(v) => setStatusFilter(v ?? '')}
          options={[{ value: 'active', label: t('users.enabled') }, { value: 'inactive', label: t('users.disabled') }]}
        />
        <Button icon={<ReloadOutlined />} onClick={load}>{t('groups.refresh')}</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('groups.create')}</Button>
        {/* 2026-08-11：列设置（公共组件；个人偏好 localStorage） */}
        <ColumnSettings defs={allDefs} colPrefs={colPrefs} onToggle={toggleCol} onReset={resetCols} />
      </Space>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <Table rowKey="id" size="small" loading={loading} columns={cols} dataSource={filteredGroups} pagination={false}
          scroll={{ x: 'max-content' }} components={{ header: { cell: ResizableTitle } }} />

        {/* 编辑弹窗：规则 / 排除成员 / 包含成员 三区 */}
        <Modal title={editing ? t('groups.editTitle', { name: editing.name }) : t('groups.createTitle')} open={modalOpen} onOk={submit} confirmLoading={saving} onCancel={() => setModalOpen(false)} width={760}>
          <Form form={form} layout="vertical">
            <Space size="middle" style={{ display: 'flex' }}>
              <Form.Item name="name" label={t('groups.groupName')} rules={[{ required: true, message: t('groups.groupNameRequired') }]} style={{ flex: 1 }}><Input /></Form.Item>
            </Space>
            <Form.Item name="description" label={t('groups.description')} style={{ marginBottom: 8 }}><Input /></Form.Item>
          </Form>

          {editing?.type === 'builtin' && <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>{t('groups.builtinHint')}</Typography.Text>}

          {/* ① 功能勾选 + 管理范围（内置角色只读） */}
          {editing?.type !== 'builtin' && (
            <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <Typography.Text strong>{t('groups.functions')}</Typography.Text>
              <Checkbox.Group style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8 }} value={functionIds}
                onChange={(v) => { setFunctionIds(v as string[]); if (!(v as string[]).includes('policy_mgmt')) setManagedLibs([]); }}>
                {FUNCTIONS.map((f) => <Checkbox key={f.key} value={f.key}>{f.label}</Checkbox>)}
              </Checkbox.Group>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>{t('groups.fnOrthogonalHint')}</Typography.Text>
              {/* 管理范围：仅勾选「政策库内容运营」时显示（2026-08-08） */}
              {functionIds.includes('policy_mgmt') && (
                <>
                  <Typography.Text strong style={{ display: 'block', marginTop: 12 }}>{t('groups.managedScope')}</Typography.Text>
                  <Select mode="multiple" allowClear style={{ width: '100%', marginTop: 8 }} placeholder={t('groups.managedScopePlaceholder')}
                    value={managedLibs} onChange={setManagedLibs}
                    options={[{ value: 'ALL', label: t('groups.allLibs') }, ...allLibs.map((l) => ({ value: l.id, label: l.name }))]} />
                  <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>{t('groups.managedScopeHint')}</Typography.Text>
                </>
              )}
            </div>
          )}
          {editing?.type === 'system_admin' && <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>{t('groups.sysAdminHint')}</Typography.Text>}
          {editing?.type === 'employee' && <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>{t('groups.employeeHint')}</Typography.Text>}

          {/* ② 动态规则（内置角色隐藏）—— 复用条件编辑器（与可见性一致） */}
          {editing?.type !== 'builtin' && (
          <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <ConditionEditor rules={rules} onChange={setRules} />
          </div>
          )}

          {/* ② 排除成员（employee 内置组隐藏：全员默认） */}
          {editing?.type !== 'employee' && (
          <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <Typography.Text strong>{t('groups.excludeMembers')}</Typography.Text>
            <div style={{ marginTop: 8 }}><MemberSelect type="exclude" label={t('groups.excludeMembers')} /></div>
          </div>
          )}

          {/* ③ 包含成员（employee 内置组隐藏） */}
          {editing?.type !== 'employee' && (
          <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12 }}>
            <Typography.Text strong>{t('groups.includeMembers')}</Typography.Text>
            <div style={{ marginTop: 8 }}><MemberSelect type="include" label={t('groups.includeMembers')} /></div>
          </div>
          )}

          {editing && (
            <Button type="link" style={{ marginTop: 12, paddingLeft: 0 }}
              onClick={async () => {
                // 2026-08-08：按当前编辑草稿（规则+包含/排除）实时预览成员，不依赖保存
                try {
                  const flatRules = rules.flatMap((r) => r.conditions.map((c) => ({ rule_no: r.rule_no, field: c.field, operator: c.operator, values: c.values })));
                  const preview = await Groups.previewMembers({ rules: flatRules, include: includeM.map((m) => m.id), exclude: excludeM.map((m) => m.id) });
                  setViewMembers({ group: { ...editing, members: preview.members ?? [] }, q: '' });
                } catch (e: any) {
                  message.error(t('groups.memberPreviewFailed', { msg: e?.message ?? String(e) }));
                }
              }}>
              <EyeOutlined /> {t('groups.previewMembers')}
            </Button>
          )}
        </Modal>

        {/* 最新成员名单弹框（实时算完整名单 + 搜索） */}
        <Modal title={viewMembers ? t('groups.membersList', { name: viewMembers.group.name }) : ''} open={!!viewMembers} footer={null} onCancel={() => setViewMembers(null)} width={600} zIndex={1001}>
          {viewMembers && (() => {
            const ms = viewMembers.group.members ?? [];
            const q = viewMembers.q.trim();
            const filtered = q ? ms.filter((m) => (m.name ?? '').includes(q) || (m.employee_no ?? '').includes(q)) : ms;
            return (
              <>
                <Input.Search placeholder={t('users.searchPlaceholder')} allowClear style={{ marginBottom: 12, width: 260 }} onSearch={(v) => setViewMembers({ group: viewMembers.group, q: v })} />
                <Table size="small" rowKey="id" pagination={{ pageSize: 8 }} dataSource={filtered}
                  columns={[
                    { title: t('groups.byName'), dataIndex: 'name', width: 90 },
                    { title: t('groups.byEmployeeNo'), dataIndex: 'employee_no', width: 90, render: (v: string) => v || '—' },
                    { title: t('groups.byDept'), dataIndex: 'department', render: (v: string) => v || '—' },
                    { title: t('groups.byPosition'), dataIndex: 'position', render: (v: string) => v || '—' },
                  ]} />
              </>
            );
          })()}
        </Modal>
      </div>
    </div>
  );
}
