// 政策全文阅读（WF-06 + §5.5 准则 1 主角唯一 / 准则 5 位置感 / 准则 6 用用户的词）
// Word→HTML 渲染（无下载入口）；章节导航锚点；引用关系双向展示
import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Typography, Spin, Empty, Anchor, App, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { Browse } from '../lib/policy-api';
import { authFetch } from '../lib/api';
import Watermark from '../components/Watermark';

interface ReadData {
  line: any;
  version: { id: string; version_no: string | null; effective_from: string; effective_to: string | null; language: string | null; published_at: string | null; computed_status?: string };
  security?: { level: string | null; level_label?: string | null; watermark: boolean; copy_protect: boolean };
  html: string;
  anchors: { level: number; text: string; anchor: string }[];
  references: { cites: { id: string; name: string }[]; cited_by: { id: string; name: string }[] };
}

export default function PolicyReadPage() {
  const { t } = useTranslation();
  const { id, versionId } = useParams();
  const { message } = App.useApp();
  const [data, setData] = useState<ReadData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState('');
  const articleRef = useRef<HTMLDivElement>(null);
  // 禁复制（S7 安全，2026-08-07）：配置开关默认开；首次触发提示一次，之后静默
  const [copyProtect, setCopyProtect] = useState(true);
  const copyWarned = useRef(false);

  useEffect(() => {
    authFetch('/api/configs').then((r) => r.json()).then((d: any) => {
      const v = d.configs?.find((c: any) => c.key === 'common.security.copy_protect_enabled')?.value ?? '1';
      setCopyProtect(v !== '0');
    }).catch(() => { /* 拉取失败保持默认开（安全优先） */ });
  }, []);

  useEffect(() => {
    // 禁复制：后端已算最终值（有密级按策略、无密级按全局），直接使用（2026-08-12）
    if (!(data?.security?.copy_protect ?? copyProtect)) return;
    const warnOnce = () => {
      if (!copyWarned.current) { copyWarned.current = true; message.info(t('policy.read.copyProtectWarn')); }
    };
    const block = (e: Event) => { e.preventDefault(); warnOnce(); };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && ['c', 'x', 'a'].includes(e.key.toLowerCase())) { e.preventDefault(); warnOnce(); }
    };
    // 绑定 document 级：article 是数据加载后才渲染，ref 绑定会错过时机；阅读页路由内即整个页面受控
    document.addEventListener('copy', block);
    document.addEventListener('contextmenu', block);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('copy', block);
      document.removeEventListener('contextmenu', block);
      document.removeEventListener('keydown', onKey);
    };
  }, [copyProtect, message, data]);

  useEffect(() => {
    setErr(null); setLoading(true); setData(null);
    const p = versionId ? Browse.readVersion(id!, versionId) : Browse.read(id!);
    p.then((d) => setData(d)).catch((e) => setErr(e?.response?.data?.error ?? t('policy.read.noVersion')))
      .finally(() => setLoading(false));
  }, [id, versionId]);

  // 锚点跳转：内容渲染后滚动到 URL hash 对应章节
  useEffect(() => {
    if (!data) return;
    const hash = window.location.hash;
    if (!hash) return;
    const id = decodeURIComponent(hash.slice(1));
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [data]);

  // pandoc standalone 输出含 <html><head><style>…<body> 完整文档，
  // dangerouslySetInnerHTML 注入后其 <style> 会污染页面布局。提取纯 body 内容。
  const safeHtml = data ? (() => {
    const bodyMatch = data.html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    return bodyMatch ? bodyMatch[1] : data.html;
  })() : '';

  const injectAnchors = (html: string) => {
    let ai = 0;
    return html.replace(/<(h1|h2|h3)([^>]*)>/g, (_, tag, attrs) => {
      const a = data?.anchors[ai++];
      return a ? `<${tag}${attrs} id="${a.anchor}">` : `<${tag}${attrs}>`;
    });
  };

  // AntD Anchor 需要 { key, href, title, children } 结构
  const anchorItems = (data?.anchors ?? []).map((a) => ({
    key: a.anchor, href: '#' + a.anchor, title: <span style={{ paddingLeft: (a.level - 1) * 14 }}>{a.text}</span>,
  }));

  // 密级 Tag（2026-08-12）：显示配置的 label（客户可改），颜色按存储键映射（稳定）
  const LEVEL_COLOR: Record<string, string> = { top_secret: 'magenta', confidential: 'red', internal: 'orange', public: 'green' };
  const secLevel = data?.security?.level;
  const secLabel = data?.security?.level_label ?? secLevel;

  return (
    <div style={{ padding: 24, height: 'calc(100vh - 52px)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
      {loading && <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spin /></div>}
      {err && !loading && <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Empty description={err} /></div>}
      {!loading && !err && data && (
        <div style={{ display: 'flex', gap: 24, flex: 1, minHeight: 0, minWidth: 0 }}>
          <aside className="read-toc" style={{ width: 'clamp(170px, 22%, 260px)', flexShrink: 0, overflow: 'auto'}}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('policy.read.toc')}</Typography.Text>
            <Anchor items={anchorItems} affix={false} getContainer={() => articleRef.current || window} onChange={(c) => setActive(String(c))} />
          </aside>
          <article ref={articleRef} className={(data.security?.copy_protect ?? copyProtect) ? 'read-protected' : ''} style={{ position: 'relative', flex: 1, minWidth: 0, overflowY: 'auto' }}>
            {(data.security?.watermark ?? false) && <Watermark enabled />}
            <Typography.Title level={3} style={{ marginBottom: 4 }}>
              {data.line?.name}
              {secLevel && <Tag color={LEVEL_COLOR[secLevel] ?? 'default'} style={{ marginLeft: 8, verticalAlign: 'middle' }}>{secLabel}</Tag>}
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {data.line?.policy_type ? `${data.line.policy_type}` : ''}
              {data.version.version_no ? ` · ${data.version.version_no}` : ''}
              {` · ${data.version.computed_status === 'pending' ? t('policy.read.pending') : t('policy.read.effectiveShort')} ${data.version.effective_from}`}
              {data.line?.publish_org ? ` · ${data.line.publish_org}` : ''}
            </Typography.Text>
            <div className="read-html" dangerouslySetInnerHTML={{ __html: injectAnchors(safeHtml) }} style={{ marginTop: 16, lineHeight: 1.7 }} />
            <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '24px 0' }} />
            {data.references.cites.length > 0 && (
              <div style={{ fontSize: 13, margin: '6px 0' }}>{t('policy.read.cites')}{data.references.cites.map((r, i) => (
                <span key={r.id}>{i > 0 && '、'}<Link to={`/policy/${r.id}`} state={{ from: 'read' }}>{r.name}</Link></span>
              ))}</div>
            )}
            {data.references.cited_by.length > 0 && (
              <div style={{ fontSize: 13, margin: '6px 0' }}>{t('policy.read.citedBy')}{data.references.cited_by.map((r, i) => (
                <span key={r.id}>{i > 0 && '、'}<Link to={`/policy/${r.id}`} state={{ from: 'read' }}>{r.name}</Link></span>
              ))}</div>
            )}
            {/* 防外泄：水印 + 禁复制由 Watermark 组件与 .read-protected 提供（2026-08-07） */}
          </article>
        </div>
      )}
    </div>
  );
}