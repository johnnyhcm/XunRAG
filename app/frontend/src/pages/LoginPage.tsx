// 登录页（S6 完整用户系统，2026-08-07，PRD §3.2）—— 工号 + 密码
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Form, Input, Button, Typography, App } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { Auth } from '../lib/policy-api';
import { fetchAppTitle } from '../lib/appTitle';
import { useSessionStore } from '../store/session';

export default function LoginPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const setToken = useSessionStore((s) => s.setToken);
  const setUserId = useSessionStore((s) => s.setUserId);
  const newSession = useSessionStore((s) => s.newSession);
  const navigate = useNavigate();
  const { message } = App.useApp();

  useEffect(() => {
    // 2026-08-11：登录页浏览器标题同步产品名（GET /api/configs 公开无鉴权）
    fetchAppTitle().catch(() => {});
  }, []);

  const onFinish = async (v: { employee_no: string; password: string }) => {
    setLoading(true);
    try {
      const r = await Auth.login(v.employee_no, v.password);
      setToken(r.token); // 登录态：token 优先，前端不再带 X-User-Id
      setUserId(undefined); // 清除测试身份残留
      newSession(); // 登录后默认进入新对话（2026-08-07：不沿用旧会话历史）
      message.success(t('login.welcome', { name: r.user.name }));
      navigate('/');
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? t('login.failed'));
    } finally { setLoading(false); }
  };

  return (
    // 2026-08-13：登录页右上角语言切换器（首次访问/未登录场景的唯一入口；登录后设置菜单亦有）
    <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#f5f5f5' }}>
      <div style={{ position: 'absolute', top: 16, right: 24 }}><LanguageSwitcher /></div>
      <Card style={{ width: 380 }}>
        <Typography.Title level={4} style={{ textAlign: 'center', marginTop: 0 }}>{t('login.title')}</Typography.Title>
        <Form onFinish={onFinish} size="large">
          <Form.Item name="employee_no" rules={[{ required: true, message: t('login.employeeNoRequired') }]}>
            <Input prefix={<UserOutlined />} placeholder={t('login.employeeNo')} autoFocus />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: t('login.passwordRequired') }]}>
            <Input.Password prefix={<LockOutlined />} placeholder={t('login.password')} />
          </Form.Item>
          <Form.Item style={{ marginBottom: 4 }}>
            <Button type="primary" htmlType="submit" block loading={loading}>{t('login.submit')}</Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
