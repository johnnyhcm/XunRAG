// 政策管理（PRD §4.2 卡片分组展示 方案 A）
// 卡片头=制度层（名称/当前版本/当前状态）；版本行=版本层（编号/状态/日期段）
// 无草稿态：未发布=编辑中工作区（灰色 Tag + 继续编辑/删除）
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, List, Typography, Tag, Modal, Input, Form, Dropdown, App, Empty, Spin, Tooltip, Select, Space, DatePicker, Radio,
} from 'antd';
import {
  PlusOutlined, UploadOutlined, EditOutlined, DeleteOutlined, StopOutlined, BranchesOutlined,
  ReadOutlined, CheckCircleOutlined, ReloadOutlined, MoreOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { Libraries, Policies, type PolicyListItem } from '../lib/policy-api';
import { authFetch } from '../lib/api';
import { timezoneOptions } from '../lib/timezones';
import SliceEditor from '../components/SliceEditor';
import ConditionEditor from '../components/ConditionEditor';
import { Groups } from '../lib/policy-api';
import { useMyPerms } from '../lib/useMyPerms';

interface LibRow { id: string; name: string; status: string; file_count: number; description?: string; created_at?: string | null }
interface VersionRow {
  id: string; version_no: string | null; status: string; effective_from: string | null;
  effective_to: string | null; change_note: string | null; published_at: string | null;
  index_status?: string; index_error?: string | null;
  computed_status?: string; // 后端按服务器时区算好（2026-08-06），前端不再自算“今天”
}
type View =
  | { mode: 'list' }
  | { mode: 'edit'; lineId: string; versionId: string; libId?: string | null; sliceOnly?: boolean };

// 派生状态 → 颜色/文案（locale 感知，zh 兜底见 PRD §8）
const statusMeta = (t: (k: string, o?: any) => string): Record<string, { color: string; label: string }> => ({
  active: { color: 'green', label: t('terms.status.published') },
  pending: { color: 'blue', label: t('policy.read.pending') },
  invalid: { color: 'default', label: t('terms.status.invalid') },
  unpublished: { color: 'orange', label: t('admin.unpublished') },
});

export default function AdminPage() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const perm = useMyPerms(); // 2026-08-07：库级操作=政策库全局管理；库内操作=政策库内容运营（正交）
  const [libs, setLibs] = useState<LibRow[]>([]);
  const [libId, setLibId] = useState<string | null>(null);
  const canGlobal = perm?.isSystemAdmin || perm?.functions?.includes('policy_library_mgmt') || false;
  // 当前库的内容运营权（2026-08-08 修复：按管理范围渲染，而非功能级——有全局管理+内容运营但未授权某库时，该库文件操作按钮不显示）
  const canManageThis = perm?.isSystemAdmin || (perm?.managed_library_ids?.includes(libId ?? '') || perm?.managed_library_ids?.includes('ALL')) || false;
  const [policies, setPolicies] = useState<PolicyListItem[]>([]);
  const [view, setView] = useState<View>({ mode: 'list' });
  const [loadingLibs, setLoadingLibs] = useState(false);
  const [loadingPolicies, setLoadingPolicies] = useState(false);
  const [libModalOpen, setLibModalOpen] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [showInvalid, setShowInvalid] = useState(false);

  // 搜索与排序
  const [libQuery, setLibQuery] = useState('');
  const [libSort, setLibSort] = useState<'name' | 'created'>('name');
  const [libSortAsc, setLibSortAsc] = useState(true); // 名称默认 A→Z
  const [fileQuery, setFileQuery] = useState('');
  const [fileSort, setFileSort] = useState<'updated' | 'created' | 'name'>('updated');
  const [fileSortAsc, setFileSortAsc] = useState(false); // 修改时间默认最晚→最早（倒序）

  // 卡片版本列表缓存：lineId → versions；服务器时区：lineId → +08:00（生效判断同源，2026-08-06）
  const [versionsByLine, setVersionsByLine] = useState<Record<string, VersionRow[]>>({});
  const [tzByLine, setTzByLine] = useState<Record<string, string>>({});
  // 弹窗
  const [editLine, setEditLine] = useState<PolicyListItem | null>(null);
  const [editVersion, setEditVersion] = useState<{ lineId: string; version: VersionRow } | null>(null);

  const loadLibs = async () => {
    setLoadingLibs(true);
    try {
      const d = await Libraries.list();
      const libArr = d.libraries ?? [];
      setLibs(libArr);
      if (libArr.length > 0) setLibId((prev) => prev ?? libArr.find((l: LibRow) => l.status === 'active')?.id ?? null);
    } catch { message.error(t('admin.loadLibsFailed')); } finally { setLoadingLibs(false); }
  };

  const loadPolicies = async (id: string) => {
    setLoadingPolicies(true);
    try {
      const d = await Policies.listByLibrary(id);
      const list = d.policies ?? [];
      setPolicies(list);
      // 并行拉取每条的版本列表（卡片默认展示版本行）
      const entries = await Promise.all(list.map(async (p) => {
        try { const v = await Policies.get(p.id); return [p.id, v.versions ?? []] as const; }
        catch { return [p.id, [] as VersionRow[]] as const; }
      }));
      setVersionsByLine(Object.fromEntries(entries));
      // 政策线时区（2026-08-13 多时区，管理端展示）
      const tzs = await Promise.all(list.map(async (p) => {
        try { const v = await Policies.get(p.id); return [p.id, v.timezone ?? ''] as const; }
        catch { return [p.id, ''] as const; }
      }));
      setTzByLine(Object.fromEntries(tzs));
    } catch { message.error(t('admin.loadPoliciesFailed')); } finally { setLoadingPolicies(false); }
  };

  useEffect(() => { loadLibs(); }, []);
  useEffect(() => {
    if (libId) {
      // 2026-08-08 方案 A：无内容运营权的库不加载文件列表（避免 403 报错，内容隔离）
      if (perm?.isSystemAdmin || perm?.managed_library_ids?.includes(libId) || perm?.managed_library_ids?.includes('ALL')) loadPolicies(libId);
      else { setPolicies([]); setVersionsByLine({}); }
    } else { setPolicies([]); setVersionsByLine({}); }
  }, [libId, perm]);

  const reloadAll = () => { if (libId) loadPolicies(libId); loadLibs(); };

  // 上传新政策：建工作区 → 进向导（发布即生效）
  const startUploadWizard = async () => {
    if (!libId) { message.info(t('admin.selectLibFirst')); return; }
    // 上传直进向导（顺流不顺数据：名称/可见性后补，编辑属性时配置）
    try {
      const r = await Policies.create(libId, { name: '未命名政策', policy_type: '制度' });
      setView({ mode: 'edit', lineId: r.line_id, versionId: r.version_id, libId });
    } catch (e: any) { message.error(t('admin.createFailed', { msg: e?.message ?? String(e) })); }
  };

  // 发新版
  const startNewVersion = async (lineId: string) => {
    try {
      const r = await Policies.newVersion(lineId);
      setView({ mode: 'edit', lineId, versionId: r.version_id, libId });
    } catch (e: any) { message.error(t('admin.newVersionFailed', { msg: e?.message ?? String(e) })); }
  };

  // 调整切片（已发布版本）
  const startAdjustSlices = (lineId: string, versionId: string) =>
    setView({ mode: 'edit', lineId, versionId, libId, sliceOnly: true });

  // 继续编辑未发布政策（进入工作区向导）
  const continueEditing = async (lineId: string) => {
    try {
      const d = await Policies.get(lineId);
      const work = (d.versions ?? []).find((v: any) => v.status === 'draft');
      if (work) setView({ mode: 'edit', lineId, versionId: work.id, libId });
      else { const r = await Policies.newVersion(lineId); setView({ mode: 'edit', lineId, versionId: r.version_id, libId }); }
    } catch (e: any) { message.error(t('admin.loadFailed', { msg: e?.message ?? '' })); }
  };

  if (view.mode === 'edit') {
    return <SliceEditor lineId={view.lineId} versionId={view.versionId} libId={view.libId}
      mode={view.sliceOnly ? 'slice' : 'wizard'}
      onBack={() => { setView({ mode: 'list' }); reloadAll(); }} />;
  }

  // 过滤：显示已废止开关控制线级
  const visiblePolicies = policies
    .filter((p) => showInvalid || p.derived_status !== 'invalid')
    .filter((p) => !fileQuery.trim() || p.name.includes(fileQuery.trim()) || (p.doc_no ?? '').includes(fileQuery.trim()));
  // 排序：libSortAsc=true → A→Z / 最早→最晚；false → 反向
  const sortPolicies = [...visiblePolicies].sort((a, b) => {
    let cmp = 0;
    if (fileSort === 'name') cmp = a.name.localeCompare(b.name, 'zh');
    else if (fileSort === 'created') cmp = String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
    else cmp = String(a.max_updated_at ?? '').localeCompare(String(b.max_updated_at ?? '')); // updated
    return fileSortAsc ? cmp : -cmp;
  });
  // 库：搜索 + 排序
  const visibleLibs = libs
    .filter((l) => showInactive || l.status === 'active')
    .filter((l) => !libQuery.trim() || l.name.includes(libQuery.trim()));
  const sortedLibs = [...visibleLibs].sort((a, b) => {
    let cmp = 0;
    if (libSort === 'name') cmp = a.name.localeCompare(b.name, 'zh');
    else cmp = String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
    return libSortAsc ? cmp : -cmp;
  });

  const sortLabel = (key: string, asc: boolean): string => {
    const nameMap: Record<string, string> = { name: t('admin.sortName'), created: t('admin.sortCreated'), updated: t('admin.sortUpdated') };
    const dir = key === 'name' ? (asc ? t('admin.sortAZ') : t('admin.sortZA')) : (asc ? t('admin.sortOldest') : t('admin.sortNewest'));
    return `${nameMap[key] ?? key}（${dir}）`;
  };
  // 2026-08-11：按钮精简为 字段名+方向箭头（完整描述在菜单项）；↑=升序 ↓=降序
  const sortName = (key: string) => ({ name: t('admin.sortName'), created: t('admin.sortCreated'), updated: t('admin.sortUpdated') }[key] ?? key);
  const handleLibSort = ({ key }: { key: string }) => {
    if (key === libSort) setLibSortAsc(!libSortAsc);
    else { setLibSort(key as any); setLibSortAsc(key === 'name'); }
  };
  const handleFileSort = ({ key }: { key: string }) => {
    if (key === fileSort) setFileSortAsc(!fileSortAsc);
    else { setFileSort(key as any); setFileSortAsc(key === 'name'); }
  };
  const sortMenuLib = [
    { key: 'name', label: sortLabel('name', libSort === 'name' ? libSortAsc : true) },
    { key: 'created', label: sortLabel('created', libSort === 'created' ? libSortAsc : false) },
  ];
  const sortMenuFile = [
    { key: 'updated', label: sortLabel('updated', fileSort === 'updated' ? fileSortAsc : false) },
    { key: 'created', label: sortLabel('created', fileSort === 'created' ? fileSortAsc : false) },
    { key: 'name', label: sortLabel('name', fileSort === 'name' ? fileSortAsc : true) },
  ];

  return (
    <div className="admin-page" style={{ padding: 24, height: 'calc(100vh - 52px)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      <Typography.Title level={4} style={{ margin: 0, marginBottom: 16, flexShrink: 0 }}>{t('nav.admin')}</Typography.Title>
      <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
        <aside style={{ width: 'clamp(200px, 20%, 280px)', flexShrink: 0, background: 'var(--bg-soft)', borderRadius: 12, padding: 12, alignSelf: 'flex-start', maxHeight: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, minHeight: 32, flexShrink: 0 }}>
            <Typography.Text type="secondary">{t('admin.libs')}</Typography.Text>
            {canGlobal && <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => setLibModalOpen(true)}>{t('admin.create')}</Button>}
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexShrink: 0 }}>
            <Input.Search size="small" placeholder={t('admin.searchLib')} value={libQuery}
              onChange={(e) => setLibQuery(e.target.value)} allowClear style={{ flex: 1 }} />
            <Dropdown menu={{ items: sortMenuLib, selectable: true, selectedKeys: [libSort], onClick: handleLibSort }} trigger={['click']}>
              <Button size="small">{sortName(libSort)} {libSortAsc ? '↑' : '↓'}</Button>
            </Dropdown>
          </div>
          <Spin spinning={loadingLibs}>
            <List
              dataSource={sortedLibs}
              locale={{ emptyText: <Empty description={libQuery ? t('admin.libEmptySearch') : t('admin.libEmpty')} /> }}
              renderItem={(l) => (
                <List.Item
                  className={l.id === libId ? 'lib-sel' : ''}
                  style={{ cursor: 'pointer', padding: '8px 12px', borderRadius: 8,
                    background: l.id === libId ? 'var(--accent-soft)' : undefined,
                    opacity: l.status !== 'active' ? 0.55 : 1 }}
                  onClick={() => setLibId(l.id)}
                >
                  <List.Item.Meta title={<span>{l.status !== 'active' ? <Tag color="default" style={{ marginRight: 6 }}>{t('terms.libStatus.inactive')}</Tag> : null}{l.name}</span>} description={t('admin.fileCount', { count: l.file_count ?? 0 })} />
                  <LibraryMenu lib={l} onReload={loadLibs} canGlobal={canGlobal} />
                </List.Item>
              )}
            />
          </Spin>
          <div style={{ marginTop: 8, flexShrink: 0 }}>
            <label style={{ fontSize: 12, color: '#999', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} style={{ margin: 0 }} /> {t('admin.showInactive')}
            </label>
          </div>
        </aside>

        <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {!libId ? (
            <Empty description={t('admin.selectLib')} style={{ marginTop: 80 }} />
          ) : !canManageThis ? (
            // 2026-08-08 方案 A：无内容运营权的库不显示文件列表（内容隔离）——仅全局管理视角提示
            <Empty description={t('admin.contentByOps')} style={{ marginTop: 80 }} />
          ) : (
            <>
              {/* 第一行：与左侧政策库标题对齐 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, minHeight: 32, flexShrink: 0 }}>
                <Typography.Text strong>{t('admin.libFileCount', { name: libs.find((l) => l.id === libId)?.name ?? '', count: sortPolicies.length })}</Typography.Text>
                {canManageThis && <Button type="primary" icon={<UploadOutlined />} onClick={startUploadWizard}>{t('admin.newPolicy')}</Button>}
              </div>
              {/* 第二行：搜索 + 排序 + 显示已废止 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexShrink: 0 }}>
                <Input.Search size="small" placeholder={t('admin.searchFile')} value={fileQuery}
                  onChange={(e) => setFileQuery(e.target.value)} allowClear style={{ maxWidth: 260 }} />
                <Dropdown menu={{ items: sortMenuFile, selectable: true, selectedKeys: [fileSort], onClick: handleFileSort }} trigger={['click']}>
                  <Button size="small">{sortName(fileSort)} {fileSortAsc ? '↑' : '↓'}</Button>
                </Dropdown>
                <label style={{ fontSize: 12, color: '#999', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
                  <input type="checkbox" checked={showInvalid} onChange={(e) => setShowInvalid(e.target.checked)} style={{ margin: 0 }} /> {t('admin.showInvalid')}
                </label>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
                <Spin spinning={loadingPolicies}>
                  {sortPolicies.length === 0 && !loadingPolicies ? (
                    <Empty description={fileQuery ? t('admin.fileEmptySearch') : t('admin.fileEmpty')} style={{ marginTop: 60 }} />
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {sortPolicies.map((p) => (
                        <PolicyCard key={p.id} policy={p} versions={versionsByLine[p.id] ?? []} serverTz={tzByLine[p.id]}
                          canContent={canManageThis}
                          onEditAttr={() => setEditLine(p)}
                          onNewVersion={() => startNewVersion(p.id)}
                          onContinueEdit={() => continueEditing(p.id)}
                          onAdjustSlices={(vid) => startAdjustSlices(p.id, vid)}
                          onEditVersion={(v) => setEditVersion({ lineId: p.id, version: v })}
                          onReload={reloadAll} />
                      ))}
                    </div>
                  )}
                </Spin>
              </div>
            </>
          )}
        </section>
      </div>

      <CreateLibModal open={libModalOpen} onClose={() => setLibModalOpen(false)} onCreated={(id) => { setLibModalOpen(false); setLibId(id); loadLibs(); }} />

      <EditLineModal line={editLine} onClose={() => setEditLine(null)} onSaved={reloadAll} />
      <VersionEditModal
        lineId={editVersion?.lineId ?? null}
        version={editVersion?.version ?? null}
        serverTz={editVersion?.lineId ? tzByLine[editVersion.lineId] : ''}
        hasPublished={editVersion?.lineId ? (versionsByLine[editVersion.lineId] ?? []).some((vv) => vv.status !== 'draft') : false}
        onClose={() => setEditVersion(null)}
        onSaved={() => { setEditVersion(null); reloadAll(); }}
      />
    </div>
  );
}

// ---------- 政策卡片 ----------
// 密级气泡（2026-08-12）：value→显示名映射（/api/security/levels），颜色按存储键稳定映射
// 2026-08-13：缓存按语言隔离（原模块级缓存跨语言复用——切语言后标签不更新）
const LV_COLOR: Record<string, string> = { top_secret: 'magenta', confidential: 'red', internal: 'orange', public: 'green' };
let secLevelCache: Record<string, { value: string; label: string }[]> = {};
function SecLevelTag({ value }: { value: string }) {
  const { i18n } = useTranslation();
  const lang = i18n.language ?? 'zh-CN';
  const [label, setLabel] = useState<string>(value);
  useEffect(() => {
    if (secLevelCache[lang]) { setLabel(secLevelCache[lang].find((l) => l.value === value)?.label ?? value); return; }
    authFetch('/api/security/levels', { headers: { 'Accept-Language': lang } }).then((r) => r.json()).then((d: any) => {
      secLevelCache[lang] = d.levels ?? [];
      setLabel(secLevelCache[lang]?.find((l) => l.value === value)?.label ?? value);
    }).catch(() => {});
  }, [value, lang]);
  return <Tag color={LV_COLOR[value] ?? 'default'} style={{ marginRight: 0 }}>{label}</Tag>;
}

function PolicyCard({ policy, versions, serverTz, onEditAttr, onNewVersion, onContinueEdit, onAdjustSlices, onEditVersion, onReload, canContent }: {
  policy: PolicyListItem; versions: VersionRow[]; serverTz?: string;
  onEditAttr: () => void; onNewVersion: () => void; onContinueEdit: () => void;
  onAdjustSlices: (vid: string) => void; onEditVersion: (v: VersionRow) => void; onReload: () => void; canContent: boolean;
}) {
  const { message, modal } = App.useApp();
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const st = statusMeta(t)[policy.derived_status] ?? statusMeta(t).unpublished;
  const isUnpublished = policy.derived_status === 'unpublished';

  // 版本显示规则：默认折叠（只显示当前生效 + 编辑中），展开显示全部
  const publishedV = versions.filter((v) => v.status !== 'draft');
  const draftVs = versions.filter((v) => v.status === 'draft');
  const activeV = publishedV.find((v) => v.computed_status === 'active');
  const defaultV = activeV ?? publishedV[0]; // 无生效版本时显示最新版本
  const hiddenV = publishedV.filter((v) => v !== defaultV);
  const collapsed = !showAll && hiddenV.length > 0;
  const visibleV = collapsed ? (defaultV ? [defaultV] : []) : publishedV;

  // 废止文件：废止当前生效版本（或最新 published）
  const stopLine = () => {
    const pub = versions.find((v) => v.status === 'published');
    if (!pub) { message.info(t('admin.noPublishToStop')); return; }
    modal.confirm({
      title: t('admin.stopLine'), content: t('admin.stopLineConfirm', { name: policy.name, no: pub.version_no ?? '' }), okText: t('admin.stopOk'), okButtonProps: { danger: true }, cancelText: t('action.cancel'),
      onOk: async () => {
        try { await Policies.invalidate(policy.id, pub.id); message.success(t('terms.status.invalid')); onReload(); }
        catch (e: any) { message.error(t('admin.stopFailed', { msg: e?.message ?? '' })); }
      },
    });
  };
  // 删除文件（强制清理）
  const deleteLine = () => {
    modal.confirm({
      title: t('admin.deleteLineTitle'),
      content: t('admin.deleteLineConfirm', { name: policy.name }),
      okText: t('users.deleteOk'), okButtonProps: { danger: true }, cancelText: t('action.cancel'),
      onOk: async () => {
        try { await Policies.deleteLine(policy.id); message.success(t('users.deleted')); onReload(); }
        catch (e: any) { message.error(t('admin.deleteFailed', { msg: e?.message ?? '' })); }
      },
    });
  };

  const lineMenu = [
    { key: 'stop', icon: <StopOutlined />, label: t('admin.stopLine'), danger: true, onClick: stopLine },
    { type: 'divider' as const },
    { key: 'del', icon: <DeleteOutlined />, label: t('admin.deleteLine'), danger: true, onClick: deleteLine },
  ];

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, background: '#fff', overflow: 'hidden' }}>
      {/* 卡片头：制度层 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid #f0f0f0', flexWrap: 'wrap' }}>
        <a href={`/policy/${policy.id}`} target="_blank" rel="noopener noreferrer"
          style={{ fontWeight: 600, fontSize: 15, color: 'var(--fg)', textDecoration: 'none' }}
          onClick={(e) => e.stopPropagation()}>{policy.name}</a>
        {policy.security_level && <SecLevelTag value={policy.security_level} />}
        <Tag color={st.color}>{st.label}</Tag>
        {!isUnpublished && policy.current_version_no && (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>{t('admin.currentVersion', { no: policy.current_version_no })}</Typography.Text>
        )}
        <Space size="small" style={{ marginLeft: 'auto' }}>
          {canContent && (isUnpublished ? (
            <>
              <Button size="small" type="link" icon={<EditOutlined />} onClick={onContinueEdit}>{t('admin.continueEdit')}</Button>
              <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={deleteLine}>{t('users.deleteOk')}</Button>
            </>
          ) : (
            <>
              <Button size="small" type="link" icon={<EditOutlined />} onClick={onEditAttr}>{t('admin.editLineAttr')}</Button>
              <Button size="small" type="link" icon={<BranchesOutlined />} onClick={onNewVersion}>{t('admin.uploadNewVersion')}</Button>
              <Dropdown menu={{ items: lineMenu }} trigger={['click']}><Button size="small" type="text" icon={<MoreOutlined />} /></Dropdown>
            </>
          ))}
        </Space>
      </div>

      {/* 版本行：版本层（默认折叠，编辑中始终显示） */}
      {!isUnpublished && (
        <div style={{ padding: '4px 16px' }}>
          {versions.length === 0 && <div style={{ padding: '8px 0', color: '#999', fontSize: 13 }}>{t('admin.noVersions')}</div>}
          {draftVs.map((v) => (
            <VersionRow key={v.id} lineId={policy.id} lineName={policy.name} version={v} serverTz={serverTz} canContent={canContent}
              onContinueEdit={onContinueEdit}
              onAdjustSlices={onAdjustSlices} onEditVersion={onEditVersion} onReload={onReload} />
          ))}
          {visibleV.map((v) => (
            <VersionRow key={v.id} lineId={policy.id} lineName={policy.name} version={v} serverTz={serverTz} canContent={canContent}
              onContinueEdit={onContinueEdit}
              onAdjustSlices={onAdjustSlices} onEditVersion={onEditVersion} onReload={onReload} />
          ))}
          {collapsed && (
            <div style={{ padding: '6px 4px' }}>
              <Button size="small" type="text" style={{ color: '#999' }} onClick={() => setShowAll(true)}>
                {t('admin.viewAllVersions', { count: hiddenV.length })}
              </Button>
            </div>
          )}
          {showAll && publishedV.length > 0 && (
            <div style={{ padding: '6px 4px' }}>
              <Button size="small" type="text" style={{ color: '#999' }} onClick={() => setShowAll(false)}>{t('admin.collapseVersions')}</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 版本行状态（2026-08-06：改由后端 computed_status 返回，服务器时区口径；前端不再自算“今天”）
const versionStatusMeta = (t: (k: string, o?: any) => string): Record<string, { color: string; label: string }> => ({
  active: { color: 'green', label: t('terms.status.published') },
  pending: { color: 'blue', label: t('policy.read.pending') },
  expired: { color: 'default', label: t('admin.expired') },
  invalid: { color: 'default', label: t('terms.status.invalid') },
  draft: { color: 'orange', label: t('admin.editing') },
});
function versionStatus(version: VersionRow, t: (k: string, o?: any) => string): { color: string; label: string } {
  return versionStatusMeta(t)[version.computed_status ?? version.status] ?? { color: 'default', label: version.status };
}

// 索引状态渲染（A 项，2026-08-06）：已入库/未入库/索引失败（含原因 + 处理建议 + 重试）
function IndexStatusBadge({ version, lineId, lineName, onReload }: { version: VersionRow; lineId: string; lineName?: string; onReload: () => void }) {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  if (version.status !== 'published') return null;
  if (version.index_status === 'indexed') {
    return <Tooltip title={t('admin.indexedTip')}><span style={{ fontSize: 12, color: '#52c41a' }}>{t('terms.indexStatus.indexed')}</span></Tooltip>;
  }
  if (version.index_status === 'failed') {
    const reason = version.index_error || t('admin.unknownReason');
    const retry = async () => {
      setRetrying(true);
      try { await Policies.reindex(lineId, version.id); message.success(t('admin.indexSuccess')); onReload(); }
      catch (e: any) { message.error(t('admin.indexFailedMsg', { msg: e?.message ?? '' })); }
      finally { setRetrying(false); }
    };
    // 2026-08-11：提示去技术化（面向内容运营者）+ 一键复制错误详情（转达系统管理员，技术细节只在详情里）
    const copyDetail = async () => {
      const detail = t('admin.copyDetailText', {
        name: lineName ?? t('admin.unknownReason'), version: version.version_no || version.id, reason,
        time: new Date().toLocaleString(),
      });
      try {
        await navigator.clipboard.writeText(detail);
        message.success(t('admin.copyDetailDone'));
      } catch { message.error(t('admin.copyDetailFailed')); }
    };
    return (
      <>
        <Tooltip title={t('admin.indexFailedTip')}>
          <Tag color="red" style={{ margin: 0, cursor: 'pointer' }}>{t('admin.indexFailed')}</Tag>
        </Tooltip>
        <Button size="small" type="link" loading={retrying} onClick={retry} style={{ padding: 0, fontSize: 12 }}>{t('admin.retry')}</Button>
        <Button size="small" type="link" onClick={copyDetail} style={{ padding: 0, fontSize: 12 }}>{t('admin.copyErrorDetail')}</Button>
      </>
    );
  }
  return <Tooltip title={t('admin.notIndexedTip')}><span style={{ fontSize: 12, color: '#8c8c8c' }}>{t('terms.indexStatus.not_indexed')}</span></Tooltip>;
}

// ---------- 版本行 ----------
function VersionRow({ lineId, lineName, version, serverTz, onContinueEdit, onAdjustSlices, onEditVersion, onReload, canContent }: {
  lineId: string; lineName?: string; version: VersionRow; serverTz?: string; onContinueEdit: () => void; onAdjustSlices: (vid: string) => void;
  onEditVersion: (v: VersionRow) => void; onReload: () => void; canContent: boolean;
}) {
  const { message, modal } = App.useApp();
  const { t } = useTranslation();
  const isDraft = version.status === 'draft';
  const isPublished = version.status === 'published';
  const st = versionStatus(version, t);

  // 废止版本（已发布）
  const stopVersion = () => {
    modal.confirm({
      title: t('admin.stopVersion'), content: t('admin.stopVersionConfirm', { no: version.version_no ?? '' }), okText: t('admin.stopOk'), okButtonProps: { danger: true }, cancelText: t('action.cancel'),
      onOk: async () => {
        try { await Policies.invalidate(lineId, version.id); message.success(t('terms.status.invalid')); onReload(); }
        catch (e: any) { message.error(t('admin.stopFailed', { msg: e?.message ?? '' })); }
      },
    });
  };
  // 删除版本（已废止 / 编辑中）
  const deleteVersion = () => {
    modal.confirm({
      title: t('admin.deleteVersionTitle'), content: t('admin.deleteVersionConfirm', { no: version.version_no || t('admin.editing') }),
      okText: t('users.deleteOk'), okButtonProps: { danger: true }, cancelText: t('action.cancel'),
      onOk: async () => {
        try { await Policies.deleteVersion(lineId, version.id); message.success(t('users.deleted')); onReload(); }
        catch (e: any) { message.error(t('admin.deleteFailed', { msg: e?.message ?? '' })); }
      },
    });
  };

  const verMenu = isPublished
    ? [
        { key: 'slice', icon: <ReloadOutlined />, label: t('admin.adjustSlices'), onClick: () => onAdjustSlices(version.id) },
        { type: 'divider' as const },
        { key: 'stop', icon: <StopOutlined />, label: t('admin.stopVersion'), danger: true, onClick: stopVersion },
      ]
    : [
        { type: 'divider' as const },
        { key: 'del', icon: <DeleteOutlined />, label: isDraft ? t('admin.deleteEditing') : t('admin.deleteVersion'), danger: true, onClick: deleteVersion },
      ];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '7px 4px', borderBottom: '1px solid #fafafa', opacity: isDraft ? 0.85 : 1 }}>
      {isDraft ? (
        <span style={{ width: 90, fontWeight: 500, color: '#999', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t('admin.editing')}</span>
      ) : (
        <a href={`/policy/${lineId}/${version.id}`} target="_blank" rel="noopener noreferrer"
          style={{ width: 90, fontWeight: 500, color: 'var(--accent)', textDecoration: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {version.version_no || '—'}
        </a>
      )}
      <Tag color={st.color} style={{ minWidth: 60, textAlign: 'center', margin: 0 }}>{st.label}</Tag>
      <IndexStatusBadge version={version} lineId={lineId} lineName={lineName} onReload={onReload} />
      <span style={{ flex: 1, color: '#666', fontSize: 13 }}>
        {isDraft
          ? t('admin.editingNotPublished')
          : `${version.effective_from ?? '—'} ${version.effective_to ? `~ ${version.effective_to}` : t('admin.longTerm')}`}
        {serverTz && !isDraft && (
          <span style={{ color: '#bbb', marginLeft: 6, fontSize: 12 }}>{t('admin.tzLabel', { label: timezoneOptions().find((o) => o.value === serverTz)?.label ?? serverTz })}</span>
        )}
      </span>
      {canContent && (<>
        {isDraft && <Button size="small" type="link" icon={<EditOutlined />} onClick={onContinueEdit}>{t('admin.continueEdit')}</Button>}
        {isPublished && <Button size="small" type="link" icon={<EditOutlined />} onClick={() => onEditVersion(version)}>{t('admin.editVersionAttr')}</Button>}
        <Dropdown menu={{ items: verMenu }} trigger={['click']}><Button size="small" type="text" icon={<MoreOutlined />} /></Dropdown>
      </>)} 
    </div>
  );
}

// ---------- 编辑属性弹窗（线级） ----------
function EditLineModal({ line, onClose, onSaved }: { line: PolicyListItem | null; onClose: () => void; onSaved: () => void }) {
  const { message, modal } = App.useApp();
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [libPolicies, setLibPolicies] = useState<{ id: string; name: string }[]>([]);
  const [refIds, setRefIds] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  // 文件可见条件（2026-08-07，S6 权限）：null=继承库；覆盖时配自己的规则
  const [inheritVisible, setInheritVisible] = useState(true);
  const [lineRules, setLineRules] = useState<any[]>([]);
  // 文件适用范围（2026-08-12，C1 软排序）：null=继承库；空规则=全员适用
  const [inheritApply, setInheritApply] = useState(true);
  const [lineApplyRules, setLineApplyRules] = useState<any[]>([]);
  // 密级档位选项（2026-08-12，来自安全设置 security/levels）
  const [secLevels, setSecLevels] = useState<{ value: string; label: string }[]>([]);
  // 业务主题选项（2026-08-13，主题多选下拉，来自问答路由 policy_topics 字典）
  const [topicOptions, setTopicOptions] = useState<{ value: string; label: string }[]>([]);
  const [warnMsg, setWarnMsg] = useState<string | null>(null);
  const parseRules = (v: string | null | undefined) => { try { const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; } catch { return []; } };
  const parseTopicArray = (t: any): string[] => { if (Array.isArray(t)) return t; if (typeof t === 'string' && t) { try { const p = JSON.parse(t); return Array.isArray(p) ? p : []; } catch { return []; } } return []; };

  useEffect(() => {
    if (!line) return;
    form.setFieldsValue({
      name: line.name, policy_type: line.policy_type ?? '', doc_no: line.doc_no ?? '',
      topic: parseTopicArray(line.topic), publish_org: line.publish_org ?? '', legal_basis: line.legal_basis ?? '',
      security_level: line.security_level ?? undefined,
    });
    authFetch('/api/security/levels').then((r) => r.json()).then((d: any) => setSecLevels(d.levels ?? [])).catch(() => {});
    authFetch('/api/configs/dicts/topics').then((r) => r.json()).then((d: any) => setTopicOptions((d.items ?? []).filter((t: any) => t.enabled !== 0).map((t: any) => ({ value: t.id, label: t.name })))).catch(() => {});
    const parseArr = (v: string | null | undefined): string[] => { try { const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; } catch { return []; } };
    setTags(parseArr((line as any).tags));
    const lv = (line as any).visible_rules;
    setInheritVisible(!lv);
    setLineRules(parseRules(lv));
    const lav = (line as any).apply_rules;
    setInheritApply(!lav);
    setLineApplyRules(parseRules(lav));
    Policies.getRefs(line.id).then((r) => setRefIds(r.cites ?? [])).catch(() => setRefIds([]));
    Policies.listByLibrary((line as any).library_id).then((d) => {
      setLibPolicies((d.policies ?? []).filter((p) => p.id !== line.id).map((p) => ({ id: p.id, name: p.name })));
    }).catch(() => setLibPolicies([]));
  }, [line, form]);

  const save = async () => {
    if (!line) return;
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    setSaving(true);
    try {
      const r: any = await Policies.updateLine(line.id, { ...v, tags: JSON.stringify(tags), visible_rules: inheritVisible ? null : lineRules, apply_rules: inheritApply ? null : lineApplyRules });
      await Policies.setRefs(line.id, refIds);
      if (r?.warnings?.length) {
        modal.warning({
          title: t('admin.visibleWarnTitle'),
          content: t('admin.visibleWarnContent', { msgs: r.warnings.map((w: any) => t('admin.visibleWarnItem', { field: w.field, value: w.value, allowed: w.allowed.join('、') })).join('；') }),
        });
      }
      message.success(t('dict.saved')); onClose(); onSaved();
    } catch (e: any) { message.error(t('config.saveFailed', { msg: e?.message ?? '' })); }
    finally { setSaving(false); }
  };

  return (
    <Modal title={t('admin.editLineAttrTitle')} open={!!line} onCancel={onClose} onOk={save} confirmLoading={saving} okText={t('action.submit')} cancelText={t('action.cancel')} width={680} bodyStyle={{ maxHeight: "72vh", overflowY: "auto" }}>
      {line && (
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('users.fName')} rules={[{ required: true, message: t('admin.nameRequired') }]}><Input /></Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Form.Item name="doc_no" label={t('admin.docNo')}><Input /></Form.Item>
            <Form.Item name="topic" label={t('admin.topic')} rules={[{ required: true, message: t('admin.topicRequired') }]}><Select mode="multiple" allowClear placeholder={t('admin.topicPlaceholder')} options={topicOptions} /></Form.Item>
            <Form.Item name="security_level" label={t('admin.secLevel')} rules={[{ required: true, message: t('admin.secLevelRequired') }]}><Select allowClear placeholder={t('admin.secLevelPlaceholder')} options={secLevels.map((s) => ({ value: s.value, label: s.label }))} /></Form.Item>
          </div>

          <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginTop: 4 }}>
            <Typography.Text strong>{t('admin.lineVisible')}</Typography.Text>
            <Radio.Group style={{ margin: '8px 0', display: 'block' }} value={inheritVisible} onChange={(e) => setInheritVisible(e.target.value)}>
              <Radio value={true}>{t('admin.inheritLib')}</Radio>
              <Radio value={false}>{t('admin.override')}</Radio>
            </Radio.Group>
            {inheritVisible
              ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('admin.visibleInheritHint')}</Typography.Text>
              : (
                <>
                  <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>{t('admin.visibleOverrideHint')}</Typography.Text>
                  <ConditionEditor rules={lineRules} onChange={setLineRules} />
                  {!lineRules.length && <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>{t('admin.visibleEmptyHint')}</Typography.Text>}
                </>
              )}
          </div>
          {/* 文件适用范围（2026-08-12，C1 软排序）——与可见范围同构、消费不同：命中=检索/回答排序加权 */}
          <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginTop: 12 }}>
            <Typography.Text strong>{t('admin.lineApply')}</Typography.Text>
            <Radio.Group style={{ margin: '8px 0', display: 'block' }} value={inheritApply} onChange={(e) => setInheritApply(e.target.value)}>
              <Radio value={true}>{t('admin.inheritLib')}</Radio>
              <Radio value={false}>{t('admin.override')}</Radio>
            </Radio.Group>
            {inheritApply
              ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('admin.applyInheritHint')}</Typography.Text>
              : (
                <>
                  <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>{t('admin.applyOverrideHint')}</Typography.Text>
                  <ConditionEditor rules={lineApplyRules} onChange={setLineApplyRules} />
                  {!lineApplyRules.length && <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>{t('admin.applyEmptyHint')}</Typography.Text>}
                </>
              )}
          </div>
        </Form>
      )}
    </Modal>
  );
}

// ---------- 版本属性编辑弹窗（版本级） ----------
function VersionEditModal({ lineId, version, serverTz, hasPublished, onClose, onSaved }: {
  lineId: string | null; version: VersionRow | null; serverTz?: string; hasPublished?: boolean; onClose: () => void; onSaved: () => void;
}) {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [tzOptions, setTzOptions] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => { setTzOptions(timezoneOptions()); }, []);

  useEffect(() => {
    if (!version) return;
    form.setFieldsValue({
      version_no: version.version_no ?? '',
      effective_from: version.effective_from ? dayjs(version.effective_from) : null,
      effective_to: version.effective_to ? dayjs(version.effective_to) : null,
      change_note: version.change_note ?? '',
      timezone: serverTz ?? undefined,
    });
  }, [version, form, serverTz]);

  const save = async () => {
    if (!lineId || !version) return;
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    const effFrom = (v.effective_from as dayjs.Dayjs | null)?.format('YYYY-MM-DD');
    if (!effFrom) { message.error(t('admin.effFromRequired')); return; }
    setSaving(true);
    try {
      await Policies.updateVersion(lineId, version.id, {
        version_no: v.version_no || null,
        effective_from: effFrom,
        effective_to: (v.effective_to as dayjs.Dayjs | null)?.format('YYYY-MM-DD') || null,
        change_note: v.change_note || null,
      });
      // 2026-08-13：时区线级——单版本（未发布）时可随版本编辑一起保存（已发布锁定由后端校验兜底）
      if (v.timezone && v.timezone !== serverTz) {
        await Policies.updateLine(lineId, { timezone: v.timezone });
      }
      message.success(t('dict.saved')); onSaved();
    } catch (e: any) { message.error(t('config.saveFailed', { msg: e?.response?.data?.error ?? e?.message ?? '' })); }
    finally { setSaving(false); }
  };

  return (
    <Modal title={t('admin.versionEditTitle', { suffix: version ? ' · ' + (version.version_no || t('admin.unpublished')) : '' })} open={!!version}
      onCancel={onClose} onOk={save} confirmLoading={saving} okText={t('action.submit')} cancelText={t('action.cancel')} width={480}>
      {version && (
        <Form form={form} layout="vertical">
          <Form.Item name="version_no" label={t('admin.versionNo')} rules={[{ required: true, message: t('admin.versionNoRequired') }]}><Input placeholder={t('admin.versionNoPlaceholder')} /></Form.Item>
          <Form.Item name="effective_from" label={t('admin.effFrom')} rules={[{ required: true, message: t('admin.effFromRequired') }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="effective_to" label={t('admin.effTo')} dependencies={['effective_from']}
            rules={[{ validator: (_, to?: dayjs.Dayjs) => {
              if (!to) return Promise.resolve();
              const from = form.getFieldValue('effective_from') as dayjs.Dayjs | undefined;
              if (from && to.isBefore(from, 'day')) return Promise.reject(new Error(t('admin.dateOrderError')));
              return Promise.resolve();
            } }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="change_note" label={t('admin.changeNote')}><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="timezone" label={t('admin.effTz')} rules={[{ required: true, message: t('admin.tzRequired') }]}>
            <Select showSearch optionFilterProp="label" disabled={hasPublished} placeholder={t('admin.selectTz')} options={tzOptions} />
          </Form.Item>
          {hasPublished && <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>{t('admin.tzLocked')}</Typography.Text>}
          {serverTz && (
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {t('admin.tzEffective', { tz: timezoneOptions().find((o) => o.value === serverTz)?.label ?? serverTz })}
            </Typography.Text>
          )}
        </Form>
      )}
    </Modal>
  );
}

// ---------- 库操作菜单 ----------
function LibraryMenu({ lib, onReload, canGlobal }: { lib: LibRow; onReload: () => void; canGlobal: boolean }) {
  const { message, modal } = App.useApp();
  const { t } = useTranslation();
  const [editOpen, setEditOpen] = useState(false);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  // 可见条件 + 管理组（2026-08-07，S6 权限）
  const [libRules, setLibRules] = useState<any[]>([]);
  // 库适用范围（2026-08-12，C1 软排序）：空规则=全员适用；文件 NULL=继承
  const [libApplyRules, setLibApplyRules] = useState<any[]>([]);

  const parseRules = (v: string | null | undefined) => { try { const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; } catch { return []; } };
  const items: any[] = canGlobal ? [
    { key: 'edit', icon: <EditOutlined />, label: t('dict.edit'), onClick: () => {
      form.setFieldsValue({ name: lib.name, description: lib.description });
      setLibRules(parseRules((lib as any).visible_rules));
      setLibApplyRules(parseRules((lib as any).apply_rules));

      setEditOpen(true);
    }},
  ] : [];
  if (canGlobal && lib.status === 'active') {
    items.push({
      key: 'stop', icon: <StopOutlined />, label: t('admin.stopLib'),
      onClick: () => {
        modal.confirm({
          title: t('admin.stopLibTitle'), content: t('admin.stopLibConfirm'), okText: t('admin.stopLib'), cancelText: t('action.cancel'),
          onOk: async () => { try { await Libraries.update(lib.id, { status: 'inactive' }); message.success(t('groups.deactivated')); onReload(); } catch { message.error(t('groups.opsFailed')); } },
        });
      },
    });
  } else if (canGlobal) {
    items.push({
      key: 'start', icon: <CheckCircleOutlined />, label: t('admin.enableLib'),
      onClick: async () => {
        try { await Libraries.update(lib.id, { status: 'active' }); message.success(t('groups.activated')); onReload(); } catch { message.error(t('groups.opsFailed')); }
      },
    });
  }
  if (canGlobal) {
    items.push({ type: 'divider' as const });
    items.push({
      key: 'del', icon: <DeleteOutlined />, label: t('admin.deleteLib'), danger: true,
    onClick: () => {
      modal.confirm({
        title: t('admin.deleteLibTitle'),
        content: (lib.file_count ?? 0) > 0 ? t('admin.deleteLibConfirmNonEmpty', { count: lib.file_count ?? 0 }) : t('admin.deleteLibConfirmEmpty'),
        okText: t('users.deleteOk'), okButtonProps: { danger: true }, cancelText: t('action.cancel'),
        onOk: async () => {
          try { await Libraries.stop(lib.id); message.success(t('users.deleted')); onReload(); } catch (e: any) { message.error(t('admin.deleteFailed', { msg: e?.message ?? '' })); }
        },
      });
    },
    });
  }
  return (
    <>
      <Dropdown menu={{ items }} trigger={['click']}><Button size="small" type="text" icon={<MoreOutlined />} onClick={(e) => e.stopPropagation()} /></Dropdown>
      <Modal title={t('admin.editLibTitle')} open={editOpen} onCancel={() => setEditOpen(false)} onOk={async () => {
        const v = await form.validateFields().catch(() => null); if (!v) return; setSaving(true);
        try {
          await Libraries.update(lib.id, { name: v.name, description: v.description, visible_rules: libRules, apply_rules: libApplyRules });
          message.success(t('groups.saved')); setEditOpen(false); onReload();
        } catch { message.error(t('config.saveFailed', { msg: '' })); } finally { setSaving(false); }
      }} confirmLoading={saving} okText={t('action.submit')} cancelText={t('action.cancel')} width={720}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('admin.libName')} rules={[{ required: true, message: t('admin.libNameRequired') }]}><Input /></Form.Item>
          <Form.Item name="description" label={t('groups.description')}><Input.TextArea rows={2} /></Form.Item>
        </Form>
        <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ marginBottom: 4 }}><Typography.Text strong>{t('admin.libVisible')}</Typography.Text></div>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>{t('admin.libVisibleHint')}</Typography.Text>
          <ConditionEditor rules={libRules} onChange={setLibRules} />
        </div>
        <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ marginBottom: 4 }}><Typography.Text strong>{t('admin.libApply')}</Typography.Text></div>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>{t('admin.libApplyHint')}</Typography.Text>
          <ConditionEditor rules={libApplyRules} onChange={setLibApplyRules} />
        </div>
      </Modal>
    </>
  );
}

function CreateLibModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (libId: string) => void }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [libRules, setLibRules] = useState<any[]>([]);
  // 新建库适用范围（2026-08-12）
  const [libApplyRules, setLibApplyRules] = useState<any[]>([]);
  const submit = async () => {
    const v = await form.validateFields().catch(() => null);
    if (!v) return;
    setLoading(true);
    try { const lib = await Libraries.create(v.name, v.description, libRules, libApplyRules); form.resetFields(); setLibRules([]); setLibApplyRules([]); onCreated(lib.id); } catch { message.error(t('admin.createFailed', { msg: '' })); } finally { setLoading(false); }
  };
  return (
    <Modal title={t('admin.createLibTitle')} open={open} onCancel={onClose} onOk={submit} confirmLoading={loading} okText={t('admin.createOk')} cancelText={t('action.cancel')} width={680}>
      <Form form={form} layout="vertical">
        <Form.Item name="name" label={t('admin.libName')} rules={[{ required: true, message: t('admin.libNameRequired') }]}>
          <Input placeholder={t('admin.libNamePlaceholder')} />
        </Form.Item>
        <Form.Item name="description" label={t('groups.description')}><Input.TextArea rows={2} placeholder={t('admin.optional')} /></Form.Item>
      </Form>
      <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <Typography.Text strong>{t('admin.libVisible')}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>{t('admin.libVisibleHint')}</Typography.Text>
        <ConditionEditor rules={libRules} onChange={setLibRules} />
      </div>
      <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12 }}>
        <Typography.Text strong>{t('admin.libApply')}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>{t('admin.libApplyHint')}</Typography.Text>
        <ConditionEditor rules={libApplyRules} onChange={setLibApplyRules} />
      </div>
    </Modal>
  );
}
