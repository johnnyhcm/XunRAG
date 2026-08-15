// 条件编辑器（复用组件，2026-08-07）：用户组动态条件 + 政策可见性共用
// - 字段下拉从 field_dicts 动态读（数据驱动，未来加字段自动出现）
// - 规则内 AND（同时满足）/ 规则间 OR（任一规则）自然语言表达
// - 值多选 showSearch（可搜索）
import { useEffect, useState } from 'react';
import { Button, Select, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { isZhUI } from '../i18n';

export interface Condition { field: string; operator?: 'in' | 'not_in'; values: string[] }
export interface RuleGroup { rule_no: number; conditions: Condition[] }
export interface FieldDef { key: string; name: string; options: { value: string; label: string }[] }

export default function ConditionEditor({ rules, onChange }: { rules: RuleGroup[]; onChange: (r: RuleGroup[]) => void }) {
  const { t } = useTranslation();
  const [fields, setFields] = useState<FieldDef[]>([]);
  useEffect(() => {
    // 2026-08-11：选项显示 label、提交 value（规则存稳定 value；历史规则已存 value 兼容）
    api.get('/field_dicts').then((r) => setFields((r.data.fields ?? [])
      .filter((f: any) => f.enabled && f.type !== 'text')
      .map((f: any) => ({ key: f.key, name: f.name, options: (f.options ?? []).filter((o: any) => o.enabled).map((o: any) => ({ value: o.value, label: isZhUI() ? o.label : (o.label_en || o.label) })) })))).catch(() => {});
  }, []);

  const fieldLabel = (key: string) => fields.find((f) => f.key === key)?.name ?? key;
  const fieldOptions = (key: string) => fields.find((f) => f.key === key)?.options ?? [];

  const addCondition = (ruleIdx: number) =>
    onChange(rules.map((r, i) => (i === ruleIdx ? { ...r, conditions: [...r.conditions, { field: fields[0]?.key ?? 'region', operator: 'in', values: [] }] } : r)));
  const addRule = () => {
    const maxNo = rules.reduce((m, r) => Math.max(m, r.rule_no), -1);
    onChange([...rules, { rule_no: maxNo + 1, conditions: [{ field: fields[0]?.key ?? 'region', operator: 'in', values: [] }] }]);
  };
  const updateCond = (ruleIdx: number, condIdx: number, patch: Partial<Condition>) =>
    onChange(rules.map((r, i) => (i === ruleIdx ? { ...r, conditions: r.conditions.map((c, j) => (j === condIdx ? { ...c, ...patch } : c)) } : r)));
  const removeCond = (ruleIdx: number, condIdx: number) =>
    onChange(rules.map((r, i) => (i === ruleIdx ? { ...r, conditions: r.conditions.filter((_, j) => j !== condIdx) } : r)));
  const removeRule = (ruleIdx: number) => onChange(rules.filter((_, i) => i !== ruleIdx)); // 2026-08-08：删除整条规则（OR 组）

  if (!fields.length) return <Typography.Text type="secondary">{t('conditionEditor.loading')}</Typography.Text>;

  return (
    <div>
      <Typography.Text strong>{t('conditionEditor.orHint')}</Typography.Text>
      {rules.map((r, ri) => (
        <div key={r.rule_no} style={{ border: '1px dashed #d9d9d9', borderRadius: 6, padding: 8, marginTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('conditionEditor.ruleAnd', { no: ri + 1 })}</Typography.Text>
            <Button size="small" type="text" danger onClick={() => removeRule(ri)}>{t('conditionEditor.removeRule')}</Button>
          </div>
          {r.conditions.map((c, ci) => (
            <Space key={ci} style={{ display: 'flex', marginTop: 6 }} wrap>
              <Select size="small" showSearch optionFilterProp="label" style={{ width: 130 }} value={c.field}
                onChange={(field) => updateCond(ri, ci, { field, values: [] })}
                options={fields.map((f) => ({ value: f.key, label: f.name }))} />
              <Select size="small" style={{ width: 92 }} value={c.operator ?? 'in'} onChange={(op) => updateCond(ri, ci, { operator: op })}
                options={[{ value: 'in', label: t('conditionEditor.contains') }, { value: 'not_in', label: t('conditionEditor.notContains') }]} />
              <Select size="small" mode="multiple" showSearch optionFilterProp="label" style={{ width: 300 }} placeholder={t('conditionEditor.searchValues')}
                value={c.values} onChange={(values) => updateCond(ri, ci, { values })}
                options={fieldOptions(c.field)} />
              <Button size="small" type="text" danger onClick={() => removeCond(ri, ci)}>✕</Button>
            </Space>
          ))}
          <Button size="small" type="link" onClick={() => addCondition(ri)}>{t('conditionEditor.addCondition')}</Button>
        </div>
      ))}
      <Button size="small" type="dashed" style={{ marginTop: 8 }} onClick={addRule}>{t('conditionEditor.addRule')}</Button>
    </div>
  );
}
