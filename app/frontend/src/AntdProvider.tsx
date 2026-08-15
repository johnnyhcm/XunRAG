// 全局 AntD 配置：ConfigProvider（动态 locale + 主题）+ App 消息上下文
// PRD §5.5：确定性来自统一组件与主题；§5.3：locale 随界面语言切换（zh_CN/en_US + dayjs）
import { type ReactNode } from 'react';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { useTranslation } from 'react-i18next';

const theme = {
  token: {
    colorPrimary: '#2563eb',
    borderRadius: 8,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
};

export default function AntdProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  const isZh = (i18n.language ?? '').startsWith('zh');
  dayjs.locale(isZh ? 'zh-cn' : 'en');
  return (
    <ConfigProvider locale={isZh ? zhCN : enUS} theme={theme}>
      <AntApp>{children}</AntApp>
    </ConfigProvider>
  );
}
