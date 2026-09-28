import { createRoot } from 'react-dom/client';
import { ConfigProvider } from 'antd-mobile';
import zhCN from 'antd-mobile/es/locales/zh-CN';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <ConfigProvider locale={zhCN}>
    <App />
  </ConfigProvider>,
);
