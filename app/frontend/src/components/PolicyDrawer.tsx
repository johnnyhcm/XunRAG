// 政策浏览抽屉（WF-05 右侧滑出）—— 接真实 /browse
import { useEffect, useState } from 'react';
import { Drawer, Input, Empty, Typography, Spin } from 'antd';
import { useTranslation } from 'react-i18next';
import { Browse } from '../lib/policy-api';

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenPolicy: (id: string) => void;
}
interface BrowseItem {
  line_id: string; name: string; policy_type: string | null; topic: string | null;
  library_id: string; library_name: string; version_no: string | null; effective_from: string;
}

export default function PolicyDrawer({ open, onClose, onOpenPolicy }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<BrowseItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');

  const load = async () => {
    setLoading(true);
    try { const d = await Browse.list(); setItems(d.policies ?? []); } catch { setItems([]); } finally { setLoading(false); }
  };
  useEffect(() => { if (open) load(); }, [open]);

  const filtered = q ? items.filter((it) => it.name.includes(q) || it.library_name.includes(q)) : items;
  const groups = Object.entries(filtered.reduce((acc: Record<string, BrowseItem[]>, it) => {
    (acc[it.library_name] ||= []).push(it); return acc;
  }, {}));

  return (
    <Drawer title={t('nav.browse')} open={open} onClose={onClose} placement="right" width="min(360px, 85vw)">
      <Input.Search placeholder={t('policy.search')} value={q} onChange={(e) => setQ(e.target.value)} allowClear style={{ marginBottom: 16 }} />
      <Spin spinning={loading}>
        {groups.length === 0 ? <Empty description={t('policy.browseEmpty')} /> :
          groups.map(([libName, list]) => (
            <div key={libName} style={{ marginBottom: 16 }}>
              <Typography.Text strong style={{ fontSize: 13 }}>▾ {libName}</Typography.Text>
              {list.map((f) => (
                <button key={f.line_id} onClick={() => { onClose(); onOpenPolicy(f.line_id); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'transparent', padding: '8px 14px', cursor: 'pointer', borderRadius: 8, fontSize: 13 }}>
                  {f.name}
                  <div style={{ color: '#999', fontSize: 11 }}>{f.policy_type ?? ''} {f.version_no ? `· ${f.version_no}` : ''} · {t('policy.effective', { date: f.effective_from })}</div>
                </button>
              ))}
            </div>
          ))}
      </Spin>
    </Drawer>
  );
}