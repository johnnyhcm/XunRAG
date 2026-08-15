// 上传政策向导（3 步：上传文件 → 维护政策属性 → 确认切片）
// Step 3 依 PRD §4.2.2 段落+切分线模型，§5.5 准则 5/7/8/9 落地
import ConditionEditor from './ConditionEditor';
import { useEffect, useRef, useState } from 'react';
import {
  Steps, Button, Typography, Space, Spin, Empty, Input, Form,
  Modal, App, Alert, Tooltip, Card, Row, Col, DatePicker, Upload, Result, Select, Tag,
} from 'antd';
import {
  ArrowLeftOutlined, SaveOutlined, SendOutlined, WarningOutlined,
  UploadOutlined, InboxOutlined, CheckCircleOutlined, HolderOutlined,
  PlusOutlined, DeleteOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import type { UploadRequestOption } from 'rc-upload/lib/interface';
import { Policies, type SliceSegment } from '../lib/policy-api';
import { authFetch } from '../lib/api';
import { timezoneOptions, browserTimezone } from '../lib/timezones';
import { chunkTypeLabel } from '../lib/terms';

// 步骤元数据（title/description 走 i18n，见 STEP_KEY）
const STEPS = [{}, {}, {}];
const STEP_KEY: Record<number, [string, string]> = { 0: ['slice.step1', 'slice.step1Desc'], 1: ['slice.step2', 'slice.step2Desc'], 2: ['slice.step3', 'slice.step3Desc'] };

const OVER_LONG = 1000; // 单 chunk 超过该 token 数提示可能影响检索

export default function SliceEditor({ lineId, versionId, libId, onBack, mode = 'wizard' }: {
  lineId: string; versionId: string; libId?: string | null; onBack: () => void;
  /** wizard=完整向导（上传→属性→切片→发布）；slice=仅调整切片（已发布版本，跳过上传与发布） */
  mode?: 'wizard' | 'slice';
}) {
  const { message, modal } = App.useApp();
  const { t } = useTranslation();
  // 2026-08-11：切片未保存检测（load 时快照，返回前对比当前 state）
  const snapshotRef = useRef<{ segments: SliceSegment[]; splits: boolean[] } | null>(null);
  const [line, setLine] = useState<any>(null);
  const [version, setVersion] = useState<any>(null);
  const [segments, setSegments] = useState<SliceSegment[]>([]);
  const [splits, setSplits] = useState<boolean[]>([]);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [savingMeta, setSavingMeta] = useState(false);
  const [savingPlan, setSavingPlan] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishForm] = Form.useForm();
  const [libPolicies, setLibPolicies] = useState<{ id: string; name: string }[]>([]);
  const [refIds, setRefIds] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [visibleRules, setVisibleRules] = useState<any[]>([]);
  // 文件适用范围（2026-08-12，C1 软排序）：空=继承库；命中【适用】的条款检索/回答优先
  const [applyRules, setApplyRules] = useState<any[]>([]);
  // 密级档位选项（2026-08-12，来自安全设置 security/levels）
  const [secLevels, setSecLevels] = useState<{ value: string; label: string }[]>([]);
  // 多时区（2026-08-13）：发布弹窗维护（线级）；已发布过 → 锁定只读
  const [tzOptions, setTzOptions] = useState<{ value: string; label: string }[]>([]);
  const [hasPublished, setHasPublished] = useState(false);
  // 业务主题选项（2026-08-13：主题多选下拉，来自问答路由 policy_topics 字典）
  const [topicOptions, setTopicOptions] = useState<{ value: string; label: string }[]>([]);
  const [lineTz, setLineTz] = useState<string | null>(null); // 政策线时区（IANA，2026-08-13 取代服务器时区）

  // 业务主题解析（2026-08-13：JSON 数组或旧自由文本）
  const parseTopics = (t: any): string[] => {
    if (Array.isArray(t)) return t;
    if (typeof t === 'string' && t) { try { const p = JSON.parse(t); return Array.isArray(p) ? p : []; } catch { return []; } }
    return [];
  };

  const load = async (opts?: { toStep?: number }) => {
    setLoading(true);
    try {
      const d = await Policies.versionDetail(lineId, versionId);
      setLine(d.line); setVersion(d.version); setSegments(d.segments ?? []); setSplits(d.splits ?? []);
      snapshotRef.current = { segments: d.segments ?? [], splits: d.splits ?? [] }; // 2026-08-11：未保存检测快照
      try { const d2 = await Policies.get(lineId); setLineTz(d2.timezone ?? null); } catch { /* 时区展示失败不阻塞 */ }
      const parseArr = (v: string | null | undefined): string[] => { try { const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; } catch { return []; } };
      setTags(parseArr(d.line?.tags));
      try { const vr = d.line?.visible_rules ? JSON.parse(d.line.visible_rules) : []; setVisibleRules(Array.isArray(vr) ? vr : []); } catch { setVisibleRules([]); }
      try { const ar = d.line?.apply_rules ? JSON.parse(d.line.apply_rules) : []; setApplyRules(Array.isArray(ar) ? ar : []); } catch { setApplyRules([]); }
      authFetch('/api/security/levels').then((r) => r.json()).then((d3: any) => setSecLevels(d3.levels ?? [])).catch(() => {});
      // 多时区：是否已有已发布版本（决定时区是否可编辑）+ 时区选项
      try { if (libId) { const lp = await Policies.listByLibrary(libId); const me = (lp.policies ?? []).find((p: any) => p.id === lineId); setHasPublished(!!me && (me.published_count ?? 0) > 0); } } catch { /* 忽略 */ }
      setTzOptions(timezoneOptions());
      // 业务主题字典（问答路由配置）
      authFetch('/api/configs/dicts/topics').then((r) => r.json()).then((d4: any) => setTopicOptions((d4.items ?? []).filter((t: any) => t.enabled !== 0).map((t: any) => ({ value: t.id, label: t.name })))).catch(() => {});
      try { const r = await Policies.getRefs(lineId); setRefIds(r.cites ?? []); } catch { setRefIds([]); }
      if (libId) { try { const lp = await Policies.listByLibrary(libId); setLibPolicies((lp.policies ?? []).filter((p) => p.id !== lineId).map((p) => ({ id: p.id, name: p.name }))); } catch { setLibPolicies([]); } }
      const hasFile = Boolean(d.version?.markdown_content);
      if (opts?.toStep !== undefined) setCurrent(opts.toStep);
      else setCurrent(mode === 'slice' ? 2 : hasFile ? 1 : 0);
    } catch { message.error(t('slice.loadFailed')); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [lineId, versionId]);

  const doUpload = async (file: File) => {
    setUploading(true);
    try {
      message.loading({ content: t('slice.converting'), key: 'up', duration: 0 });
      await Policies.upload(lineId, versionId, file);
      const fallback = ['未命名政策', '新政策'];
      if (line && fallback.includes(line.name)) {
        const fname = file.name.replace(/\.(docx|md|markdown)$/i, '');
        // 2026-08-12 修复：改名只传 name——回传整个 line 会把 security_level:null 等字段带进 PATCH（触发密级必填校验 400）
        await Policies.updateLine(lineId, { name: fname });
      }
      message.success({ content: t('slice.uploadSuccess'), key: 'up' });
      await load({ toStep: 1 });
    } catch (e: any) {
      message.error({ content: t('slice.uploadFailed', { msg: e?.message ?? String(e) }), key: 'up' });
    } finally { setUploading(false); }
  };

  // ---- Step 2 政策属性保存 ----
  const saveMetadata = async () => {
    setSavingMeta(true);
    try {
      // 2026-08-13 修复：不回传 null 敏感字段（timezone/security_level 新建时为 null，触发后端校验 400）——
      //   只传可编辑字段 + 非空的值
      const patch: any = { name: line?.name, policy_type: line?.policy_type ?? null, doc_no: line?.doc_no ?? null, topic: line?.topic ?? null, publish_org: line?.publish_org ?? null, legal_basis: line?.legal_basis ?? null, tags: JSON.stringify(tags), visible_rules: visibleRules, apply_rules: applyRules };
      if (line?.security_level) patch.security_level = line.security_level;
      if (line?.timezone) patch.timezone = line.timezone;
      await Policies.updateLine(lineId, patch);
      await Policies.setRefs(lineId, refIds);
      await load({ toStep: 2 }); message.success(t('slice.metaSaved'));
    } catch { message.error(t('config.saveFailed', { msg: '' })); } finally { setSavingMeta(false); }
  };

  // ---- Step 3 切片确认 ----
  const toggleRetained = (i: number) =>
    setSegments((ss) => ss.map((s, idx) => (idx === i ? { ...s, retained: !s.retained } : s)));
  // 切分线：态A 删除 = splits[i+1]=false；态B 添加 = splits[i+1]=true
  const setSplit = (i: number, val: boolean) =>
    setSplits((sp) => sp.map((s, idx) => (idx === i ? val : s)));
  // 段落级拖拽：把切分线从位置 from 移到 to。
  // 目标已有切分线 = 合并语义（from 删除、to 保持），即两条线并成一条
  const dragSplit = (from: number, to: number) => {
    if (to <= 0 || to >= splits.length || from === to) return;
    setSplits((sp) => sp.map((s, idx) => (idx === from ? false : idx === to ? true : s)));
  };
  // 合并语义由拖拽完成（拖到已有线=合并）；无独立 onMerge 按钮（2026-08-06 取消"建议合并"提示）

  const savePlan = async () => {
    setSavingPlan(true);
    try {
      await Policies.updatePlan(lineId, versionId, segments, splits);
      snapshotRef.current = { segments, splits }; // 2026-08-11：保存后快照同步，清除未保存状态
      message.success(mode === 'slice' ? t('slice.planSaved') : t('slice.planSavedShort'));
    }
    catch { message.error(t('config.saveFailed', { msg: '' })); } finally { setSavingPlan(false); }
  };

  // 2026-08-11：返回前检测未保存的切片调整（wizard/slice 一致）——对比快照，有差异弹确认
  const hasUnsaved = (() => {
    const s = snapshotRef.current;
    if (!s) return false;
    return JSON.stringify(s.segments) !== JSON.stringify(segments) || JSON.stringify(s.splits) !== JSON.stringify(splits);
  })();
  const handleBack = () => {
    if (hasUnsaved) {
      modal.confirm({
        title: t('slice.unsavedTitle'),
        content: t('slice.unsavedContent'),
        okText: t('slice.discardAndBack'), okButtonProps: { danger: true }, cancelText: t('slice.continueEdit'),
        onOk: onBack,
      });
    } else onBack();
  };

  // ---- 发布 ----
  const openPublish = () => {
    // 2026-08-12：发布弹窗默认密级 = 当前 line 密级 ?? 内部（发布时必填确认）
    // 2026-08-13：时区默认 = 当前 line 时区 ?? 浏览器时区（首版发布），已发布则锁定显示
    publishForm.setFieldsValue({ version_no: version?.version_no ?? '', effective_from: undefined, effective_to: undefined, change_note: version?.change_note ?? '', security_level: line?.security_level ?? 'internal', timezone: (line as any)?.timezone ?? browserTimezone() });
    setPublishOpen(true);
  };
  const doPublish = async () => {
    const v = await publishForm.validateFields().catch(() => null);
    if (!v) return;
    const effFrom = (v.effective_from as dayjs.Dayjs)?.format('YYYY-MM-DD');
    const effTo = (v.effective_to as dayjs.Dayjs | undefined)?.format('YYYY-MM-DD') || null;
    if (!effFrom) { message.error(t('admin.effFromRequired')); return; }
    setPublishing(true);
    try {
      // 2026-08-11：发布即携带最新切片分割（后端同步保存 slice_plan + 重建 chunks + 向量化，保证界面/DB/向量库一致）
      // 2026-08-12：发布携带 security_level（密级发布必填，后端同步更新 line）
      await Policies.publish(lineId, versionId, { version_no: v.version_no ?? null, effective_from: effFrom, effective_to: effTo, language: 'zh', change_note: v.change_note ?? null, security_level: v.security_level, timezone: v.timezone, segments, splits });
      message.success(t('slice.published')); setPublishOpen(false); onBack();
    } catch (e: any) { message.error(t('slice.publishFailed', { msg: e?.response?.data?.error ?? String(e) })); }
    finally { setPublishing(false); }
  };

  if (loading) return <div style={{ padding: 24 }}><Spin /></div>;

  const retainedCount = segments.filter((s) => s.retained).length;
  const discardCount = segments.length - retainedCount;
  const hasFile = Boolean(version?.markdown_content);

  // 计算每个 chunk（切分线之间）的 token 之和（供右侧切片清单展示）

  // 实时聚合 chunk metadata（与后端 aggregateChunks 逻辑一致，供右侧切片清单展示）
  const chunks = computeChunks(segments, splits);
  const OVER_LONG = 1000; // 单 chunk 超过该 token 数提示可能影响检索

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>
      <Space style={{ marginBottom: 20 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={handleBack}>{t('slice.backToAdmin')}</Button>
        <Typography.Title level={4} style={{ margin: 0 }}>{line?.name ?? ''}</Typography.Title>
      </Space>

      {mode !== 'slice' && <Steps current={current} items={STEPS.map((s, i) => ({ title: t(STEP_KEY[i][0]), description: t(STEP_KEY[i][1]) }))} style={{ marginBottom: 24 }} />}

      {/* ============ Step 1 上传文件 ============ */}
      {current === 0 && (
        <Card>
          {!hasFile ? (
            <Upload.Dragger
              accept=".docx,.md,.markdown" showUploadList={false} multiple={false} disabled={uploading}
              customRequest={(r: UploadRequestOption) => { if (r.file instanceof File) doUpload(r.file); }}
            >
              <p className="ant-upload-drag-icon">{uploading ? <Spin /> : <InboxOutlined />}</p>
              <p className="ant-upload-text">{uploading ? t('slice.converting') : t('slice.uploadText')}</p>
              <p className="ant-upload-hint">{t('slice.uploadHint')}</p>
            </Upload.Dragger>
          ) : (
            <Result
              icon={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
              title={t('slice.uploaded')}
              subTitle={t('slice.uploadedSub', { count: segments.length, discard: discardCount })}
              extra={[
                <Upload key="re" accept=".docx,.md,.markdown" showUploadList={false} disabled={uploading}
                  customRequest={(r: UploadRequestOption) => { if (r.file instanceof File) doUpload(r.file); }}>
                  <Button icon={<UploadOutlined />} loading={uploading} danger>{t('slice.reUpload')}</Button>
                </Upload>,
              ]}
            />
          )}
        </Card>
      )}

      {/* ============ Step 2 维护政策属性 ============ */}
      {current === 1 && (
        <Card title={t('slice.metaTitle')}>
          <Row gutter={12}>
            <Col span={8}><AttrField label={`${t('users.fName')} *`} value={line?.name} onChange={(v) => setLine({ ...line, name: v })} required /></Col>
            <Col span={8}><AttrField label={t('admin.docNo')} value={line?.doc_no} onChange={(v) => setLine({ ...line, doc_no: v })} /></Col>
            <Col span={8}>
              <Form.Item label={t('admin.topic')} style={{ marginBottom: 12 }}>
                <Select mode="multiple" allowClear style={{ width: '100%' }} placeholder={t('admin.topicPlaceholder')}
                  value={parseTopics(line?.topic)} onChange={(v) => setLine({ ...line, topic: v })}
                  options={topicOptions} />
              </Form.Item>
            </Col>
            <Col span={8}><AttrField label={t('admin.secLevel')} value={line?.security_level} onChange={(v) => setLine({ ...line, security_level: v })} placeholder={t('admin.secLevelPlaceholder')} select={secLevels} required /></Col>
          </Row>
          <Row gutter={12} style={{ marginTop: 4 }}>
            <Col span={24}>
              <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                <Typography.Text strong>{t('admin.lineVisible')}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>{t('slice.visibleHint')}</Typography.Text>
                <ConditionEditor rules={visibleRules} onChange={setVisibleRules} />
              </div>
            </Col>
            <Col span={24}>
              <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                <Typography.Text strong>{t('admin.lineApply')}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>{t('slice.applyHint')}</Typography.Text>
                <ConditionEditor rules={applyRules} onChange={setApplyRules} />
              </div>
            </Col>
          </Row>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('slice.s6Note')}</Typography.Text>
        </Card>
      )}

      {/* ============ Step 3 确认切片 ============ */}
      {current === 2 && (
        <div>
          <Alert type="info" showIcon style={{ marginBottom: 12 }}
            message={t('slice.step3Hint')} />
          <div style={{ maxHeight: '65vh', overflowY: 'auto' }}>
            {segments.length === 0 && <Empty description={t('slice.noSegments')} />}
            {/* 段 → 所属 chunk 映射 + 保留切块连续编号（丢弃的不占号） */}
            {(() => {
              const segToChunk: (number | null)[] = segments.map(() => null);
              chunks.forEach((c, ci) => c.segment_indices.forEach((si) => { segToChunk[si] = ci; }));
              // 保留切块的显示序号（丢弃的为 0 不占号）
              const displayNo: number[] = chunks.map(() => 0);
              let n = 0;
              chunks.forEach((c, ci) => { if (c.retained) displayNo[ci] = ++n; });
              return segments.map((seg, i) => {
                const ci = segToChunk[i];
                const chunk = ci != null ? chunks[ci] : null;
                const isHeadingSeg = seg.isPureHeading && !chunk;
                // 独立标题块（前后都有切分线）：作为独立切块显示编号
                const standaloneHeading = seg.isPureHeading && chunk != null;
                // 仅切块第一段右列显示 metadata（避免同切块多段落重复）
                const isChunkFirst = chunk != null && chunk.segment_indices[0] === i;
                return (
                  <div key={i}>
                    {/* 段落 i 之前的切分线：段级精确对应 splits[i] */}
                    {i > 0 && (
                      <SplitLine
                        exists={splits[i]}
                        onDelete={() => setSplit(i, false)}
                        onAdd={() => setSplit(i, true)}
                        onDropTo={(from) => dragSplit(from, i)}
                        index={i}
                        occupied={splits}
                        segmentsLen={segments.length}
                      />
                    )}
                    {/* 段落行：左内容 + 右所属切片 metadata（切块首段显示一次，其余对齐留白） */}
                    <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <SegmentCard seg={seg} onToggleRetained={() => toggleRetained(i)} />
                      </div>
                      <div style={{ width: 190, flexShrink: 0, borderLeft: '1px solid #f0f0f0', paddingLeft: 12, fontSize: 12, color: '#666' }}>
                        {isHeadingSeg && <div style={{ color: '#bbb' }}>{seg.retained ? t('slice.headingPrefix') : t('slice.headingSeg')}</div>}
                        {standaloneHeading && isChunkFirst && chunk && (
                          chunk.retained ? (
                            <div>
                              <div>{t('slice.chunkNo', { no: displayNo[ci as number] })}</div>
                              <div style={{ marginTop: 2 }}>{t('slice.sectionPath', { path: chunk.section_path || t('slice.none') })}</div>
                              <div style={{ marginTop: 2 }}>{t('slice.chunkLen', { count: chunk.tokens })}</div>
                            </div>
                          ) : (
                            <div style={{ color: '#bbb' }}>{t('slice.discarded')}</div>
                          )
                        )}
                        {isChunkFirst && chunk && (
                          chunk.retained ? (
                            <div>
                              <div>{t('slice.chunkNo', { no: displayNo[ci as number] })}</div>
                              <div style={{ marginTop: 2 }}>{t('slice.sectionPath', { path: chunk.section_path || t('slice.none') })}</div>
                              <div style={{ marginTop: 2, color: chunk.tokens > OVER_LONG ? '#cf1322' : undefined, fontWeight: chunk.tokens > OVER_LONG ? 600 : 400 }}>
                                {t('slice.chunkLen', { count: chunk.tokens })}
                              </div>
                              {chunk.tokens > OVER_LONG && (
                                <div style={{ color: '#cf1322', marginTop: 2 }}>{t('slice.tooLong')}</div>
                              )}
                              {chunk.has_table && <div style={{ marginTop: 2 }}>{t('slice.hasTable')}</div>}
                            </div>
                          ) : (
                            <div style={{ color: '#bbb' }}>{t('slice.discarded')}</div>
                          )
                        )}
                      </div>
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* 统一底部操作栏（2026-08-11：上一步恒左、主操作恒右下、次操作在主操作左侧；wizard/slice 结构一致） */}
      <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          {mode !== 'slice' && current > 0 && hasFile && <Button onClick={() => setCurrent(current - 1)}>{t('slice.prevStep')}</Button>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {current === 0 && hasFile && mode !== 'slice' && (
            <Button type="primary" onClick={() => setCurrent(1)} disabled={uploading}>{t('slice.toMeta')}</Button>
          )}
          {current === 1 && mode !== 'slice' && (
            <Button type="primary" loading={savingMeta} onClick={saveMetadata}>{t('slice.saveAndNext')}</Button>
          )}
          {current === 2 && (
            <>
              <Button icon={<SaveOutlined />} loading={savingPlan} onClick={savePlan}>{t('slice.saveSlices')}</Button>
              {mode !== 'slice' && (
                <Tooltip title={retainedCount === 0 ? t('slice.noSegments') : ''}>
                  <Button type="primary" icon={<SendOutlined />} disabled={retainedCount === 0} onClick={openPublish}>{t('slice.publishAndGo')}</Button>
                </Tooltip>
              )}
            </>
          )}
        </div>
      </div>

      {/* 发布确认弹窗 —— 防错：结束日期不早于开始；区间不重叠后端校验 */}
      <Modal title={t('slice.publishTitle', { name: line?.name ?? '' })} open={publishOpen} onCancel={() => setPublishOpen(false)} onOk={doPublish} confirmLoading={publishing} okText={t('slice.publishOk')} cancelText={t('action.cancel')} width={440}>
        <Form form={publishForm} layout="vertical">
          <Form.Item name="version_no" label={t('admin.versionNo')} rules={[{ required: true, message: t('admin.versionNoRequired') }]}><Input placeholder={t('admin.versionNoPlaceholder')} /></Form.Item>
          <Form.Item name="effective_from" label={t('admin.effFrom')} rules={[{ required: true, message: t('admin.effFromRequired') }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="timezone" label={t('admin.effTz')} rules={[{ required: true, message: t('admin.tzRequired') }]}>
            <Select showSearch optionFilterProp="label" disabled={hasPublished} placeholder={t('slice.selectTz')} options={tzOptions} />
          </Form.Item>
          {hasPublished && <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>{t('admin.tzLocked')}</Typography.Text>}
          <Form.Item name="effective_to" label={t('admin.effTo')} dependencies={['effective_from']}
            rules={[{ validator: (_, to?: dayjs.Dayjs) => {
              if (!to) return Promise.resolve();
              const from = publishForm.getFieldValue('effective_from') as dayjs.Dayjs | undefined;
              if (from && to.isBefore(from, 'day')) return Promise.reject(new Error(t('admin.dateOrderError')));
              return Promise.resolve();
            } }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="change_note" label={t('admin.changeNote')}><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="security_level" label={t('slice.secLevelLabel')} rules={[{ required: true, message: t('admin.secLevelRequired') }]}>
            <Select placeholder={t('slice.selectSecLevel')} options={secLevels.map((s) => ({ value: s.value, label: s.label }))} />
          </Form.Item>
          {lineTz && <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>{t('admin.tzEffective', { tz: timezoneOptions().find((o) => o.value === lineTz)?.label ?? lineTz })}</Typography.Text>}
        </Form>
        <Alert type="warning" showIcon style={{ marginTop: 8 }} message={t('slice.publishAlert')} />
      </Modal>
    </div>
  );
}

// ============ 实时聚合 chunk metadata（与后端 aggregateChunks 逻辑一致） ============
function computeChunks(segments: SliceSegment[], splits: boolean[]): {
  index: number; section_path: string; tokens: number; has_table: boolean; retained: boolean; segment_indices: number[];
}[] {
  const chunks: { index: number; section_path: string; tokens: number; has_table: boolean; retained: boolean; segment_indices: number[] }[] = [];
  let cur: number[] = [];
  const headingStack: { level: number; text: string }[] = [];
  const contentStack: { level: number; text: string }[] = [];
  const currentPath = () => headingStack.map((h) => h.text).join(' > ');
  const pushHeading = (level: number, text: string, retained: boolean) => {
    while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
    headingStack.push({ level, text });
    while (contentStack.length && contentStack[contentStack.length - 1].level >= level) contentStack.pop();
    if (retained) contentStack.push({ level, text });
  };
  const flush = () => {
    if (cur.length === 0) return;
    const segs = cur.map((i) => segments[i]);
    // 独立标题块：仅标题文本 token；否则正文 + 前缀 token
    const isStandaloneHeading = segs.length === 1 && segs[0].isPureHeading;
    const bodyTokens = segs.reduce((a, s) => a + (s.tokens ?? 0), 0);
    const prefixTokens = contentStack.reduce((a, h) => a + h.text.length, 0);
    chunks.push({
      index: chunks.length,
      section_path: currentPath(),
      tokens: isStandaloneHeading ? bodyTokens : bodyTokens + prefixTokens,
      has_table: segs.some((s) => s.has_table),
      retained: segs.some((s) => s.retained),
      segment_indices: [...cur],
    });
    cur = [];
  };
  const HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/;
  for (let i = 0; i < segments.length; i++) {
    if (splits[i]) flush();
    const seg = segments[i];
    if (seg.isPureHeading) {
      const m = seg.text.match(HEADING_RE);
      if (m && seg.level) pushHeading(Number(seg.level.replace('H', '')), m[2], seg.retained);
      // 标题段后也有切分线 → 独立成块
      if (splits[i + 1]) cur.push(i);
      continue;
    }
    cur.push(i);
  }
  flush();
  return chunks;
}

// ============ 段落卡片 ============
function SegmentCard({ seg, onToggleRetained }: { seg: SliceSegment; onToggleRetained: () => void }) {
  const { t } = useTranslation();
  const discard = !seg.retained;
  const suggested = seg.type !== 'body';
  return (
    <div
      onClick={onToggleRetained}
      style={{
        border: discard ? '1px dashed #d9d9d9' : '1px solid #d9f7be',
        background: discard ? 'rgba(0,0,0,0.02)' : '#f6ffed',
        borderRadius: 8, padding: '10px 12px', marginBottom: 0, opacity: discard ? 0.55 : 1,
        borderLeft: suggested ? '3px solid #faad14' : undefined,
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <Space size={6}>
          {seg.level && <Tag color="geekblue">{seg.level}</Tag>}
          {seg.type !== 'body' && <Tag color="orange"><WarningOutlined /> {chunkTypeLabel(seg.type)}</Tag>}
          {seg.has_table && <Tag>{t('slice.hasTable')}</Tag>}
        </Space>
        <Tooltip title={discard ? t('slice.clickRetain') : t('slice.clickDiscard')}>
          <Tag color={discard ? 'default' : 'green'} style={{ cursor: 'pointer' }}>
            {discard ? t('slice.discarded') : t('slice.retained')}
          </Tag>
        </Tooltip>
      </div>
      <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 140, overflow: 'auto', pointerEvents: 'none' }}>{seg.text}</pre>
      <div style={{ color: '#999', fontSize: 11, marginTop: 4 }}>{t('slice.tokensHint', { count: seg.tokens })}</div>
    </div>
  );
}

// ============ 切分线（态A 实线 / 态B 虚线） ============
// 拖拽源记录（模块级，避免 draggable 元素间 dataTransfer 数据错乱）
let dragFromIdx: number | null = null;

function SplitLine({ exists, onDelete, onAdd, onDropTo, index, occupied, segmentsLen }: {
  exists: boolean;
  onDelete: () => void; onAdd: () => void;
  onDropTo: (from: number) => void; index: number; occupied: boolean[]; segmentsLen: number;
}) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  if (exists) {
    return (
      <div
        style={{ display: 'flex', alignItems: 'center', height: 28, padding: '0 8px', cursor: 'pointer' }}
        onMouseEnter={() => setOver(true)} onMouseLeave={() => setOver(false)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); if (dragFromIdx != null) { onDropTo(dragFromIdx); dragFromIdx = null; } }}
      >
        <div style={{ flex: 1, borderTop: '2px solid #1677ff' }} />
        <Space size={4} style={{ padding: '0 8px' }} onClick={(e) => e.stopPropagation()}>
          <Tooltip title={t('slice.dragSplitTip')}>
            <HolderOutlined
              draggable
              style={{ color: '#1677ff', cursor: 'grab', fontSize: 14 }}
              onDragStart={(e) => { e.stopPropagation(); dragFromIdx = index; }}
            />
          </Tooltip>
          <Tooltip title={t('slice.deleteSplitTip')}>
            <Button size="small" type="text" icon={<DeleteOutlined />} onClick={(e) => { e.stopPropagation(); onDelete(); }} />
          </Tooltip>
        </Space>
        <div style={{ flex: 1, borderTop: '2px solid #1677ff' }} />
      </div>
    );
  }
  // 态B：无切分线，hover 出 + 添加
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', height: 22, padding: '0 8px', cursor: 'pointer' }}
      onMouseEnter={() => setOver(true)} onMouseLeave={() => setOver(false)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); if (dragFromIdx != null) { onDropTo(dragFromIdx); dragFromIdx = null; } }}
      onClick={onAdd}
    >
      <div style={{ flex: 1, borderTop: over ? '1px dashed #1677ff' : '1px dashed #e8e8e8' }} />
      {over && (
        <span style={{ padding: '0 8px', color: '#1677ff', fontSize: 12 }}>
          <PlusOutlined /> {t('slice.splitHere')}
        </span>
      )}
      <div style={{ flex: 1, borderTop: over ? '1px dashed #1677ff' : '1px dashed #e8e8e8' }} />
    </div>
  );
}

// ============ 政策属性字段 ============
function AttrField({ label, value, onChange, placeholder, required, muted, select }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean; muted?: boolean; select?: { value: string; label: string }[] }) {
  const { t } = useTranslation();
  return (
    <Form.Item label={muted ? <Tooltip title={t('slice.s6Effective')}><span style={{ color: '#999' }}>{label}</span></Tooltip> : label} required={required} style={{ marginBottom: 12 }}>
      {select ? (
        <Select allowClear style={{ width: '100%' }} value={value || undefined} onChange={(v) => onChange(v ?? '')} placeholder={placeholder}
          options={select.map((s) => ({ value: s.value, label: s.label }))} />
      ) : (
        <Input value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={muted} />
      )}
    </Form.Item>
  );
}