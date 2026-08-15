// 修改密码弹窗（2026-08-09，ISSUE #44，PRD §3.2）
// - force=false 常规：⚙ 个人设置入口——需当前密码；可关闭
// - force=true 强制：首次登录强制改密（must_change_password=1 且配置 force_change_on_first_login 开启）——
//   登录已验证身份，免当前密码（后端按标志+配置豁免）；不可关闭（closable/maskClosable/keyboard=false）
import { Form, Input, Modal, message } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Auth } from '../lib/policy-api';

function validateStrength(pw: string, t: (k: string) => string): string | null {
  if (pw.length < 8) return t('password.short');
  if (!/[a-z]/.test(pw)) return t('password.lower');
  if (!/[A-Z]/.test(pw)) return t('password.upper');
  if (!/\d/.test(pw)) return t('password.digit');
  return null;
}

interface Props {
  open: boolean;
  force: boolean;
  onClose: () => void;
  onChanged?: () => void;
}

export default function ChangePassword({ open, force, onClose, onChanged }: Props) {
  const { t } = useTranslation();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const submit = async (values: { currentPassword?: string; newPassword: string }) => {
    const { currentPassword, newPassword } = values;
    if (!force && newPassword === currentPassword) { message.warning(t('password.sameAsCurrent')); return; }
    setSubmitting(true);
    try {
      await Auth.changePassword(currentPassword ?? '', newPassword, force);
      message.success(t('password.success'));
      form.resetFields();
      onChanged?.();
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? t('password.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={force ? t('password.titleForce') : t('password.title')}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={submitting}
      closable={!force}
      maskClosable={!force}
      keyboard={!force}
      destroyOnClose
    >
      {force && (
        <p style={{ marginBottom: 12, color: '#fa541c', fontSize: 13 }}>
          {t('password.forceHint')}
        </p>
      )}
      <Form form={form} layout="vertical" onFinish={submit}>
        {!force && (
          <Form.Item name="currentPassword" label={t('password.currentLabel')} rules={[{ required: true, message: t('password.currentRequired') }]}>
            <Input.Password placeholder={t('password.currentRequired')} autoComplete="current-password" />
          </Form.Item>
        )}
        <Form.Item
          name="newPassword"
          label={t('password.newLabel')}
          rules={[
            { required: true, message: t('password.newRequired') },
            {
              validator: (_, v: string) => {
                if (!v) return Promise.resolve();
                const err = validateStrength(v, (k) => t(k));
                return err ? Promise.reject(new Error(err)) : Promise.resolve();
              },
            },
          ]}
        >
          <Input.Password placeholder={t('password.rule')} autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirmPassword"
          label={t('password.confirmLabel')}
          dependencies={['newPassword']}
          rules={[
            { required: true, message: t('password.confirmRequired') },
            ({ getFieldValue }) => ({
              validator: (_, v: string) =>
                !v || getFieldValue('newPassword') === v ? Promise.resolve() : Promise.reject(new Error(t('password.confirmMismatch'))),
            }),
          ]}
        >
          <Input.Password placeholder={t('password.confirmPlaceholder')} autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
