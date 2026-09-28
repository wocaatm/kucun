import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { SpinLoading, TabBar } from 'antd-mobile';
import { AddCircleOutline, AppOutline, FileOutline, UnorderedListOutline, UserOutline } from 'antd-mobile-icons';
import { SessionProvider, useSession } from './store';
import Login from './pages/Login';
import Home from './pages/Home';
import Products from './pages/Products';
import ProductDetail, { ProductEditPage } from './pages/ProductDetail';
import RecordHub from './pages/RecordHub';
import StockDocPage from './pages/StockDocPage';
import MoneyDocPage from './pages/MoneyDocPage';
import Docs from './pages/Docs';
import DocDetail from './pages/DocDetail';
import ReturnPage from './pages/ReturnPage';
import TaobaoPage from './pages/TaobaoPage';
import TaobaoOrderPage from './pages/TaobaoOrderPage';
import PluginPage from './pages/PluginPage';
import Me, { BackupPage, LogsPage, OpeningPage, PasswordPage } from './pages/Me';

// Excel 解析库较大，只在导入页按需加载
const ImportPage = lazy(() => import('./pages/ImportPage'));

const TABS = [
  { key: '/', title: '首页', icon: <AppOutline /> },
  { key: '/products', title: '商品', icon: <UnorderedListOutline /> },
  { key: '/record', title: '记一笔', icon: <AddCircleOutline /> },
  { key: '/docs', title: '单据', icon: <FileOutline /> },
  { key: '/me', title: '我的', icon: <UserOutline /> },
];

function Shell() {
  const { user, ready } = useSession();
  const loc = useLocation();
  const nav = useNavigate();

  if (!ready)
    return (
      <div className="center-screen">
        <SpinLoading color="primary" />
      </div>
    );
  if (!user) return <Login />;

  const showTabs = TABS.some((t) => t.key === loc.pathname);
  return (
    <>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/products" element={<Products />} />
        <Route path="/products/new" element={<ProductEditPage />} />
        <Route
          path="/products/import"
          element={
            <Suspense fallback={<div className="center-screen"><SpinLoading color="primary" /></div>}>
              <ImportPage />
            </Suspense>
          }
        />
        <Route path="/products/:id" element={<ProductDetail />} />
        <Route path="/products/:id/edit" element={<ProductEditPage />} />
        <Route path="/record" element={<RecordHub />} />
        <Route path="/new/:type" element={<StockDocPage />} />
        <Route path="/money/:type" element={<MoneyDocPage />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/docs/:id" element={<DocDetail />} />
        <Route path="/docs/:id/return" element={<ReturnPage />} />
        <Route path="/taobao" element={<TaobaoPage />} />
        <Route path="/taobao/orders/:no" element={<TaobaoOrderPage />} />
        <Route path="/plugin" element={<PluginPage />} />
        <Route path="/me" element={<Me />} />
        <Route path="/opening" element={<OpeningPage />} />
        <Route path="/backup" element={<BackupPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/password" element={<PasswordPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {showTabs && (
        <div className="tabbar">
          <TabBar activeKey={loc.pathname} onChange={(k) => nav(k)}>
            {TABS.map((t) => (
              <TabBar.Item key={t.key} icon={t.icon} title={t.title} />
            ))}
          </TabBar>
        </div>
      )}
    </>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </SessionProvider>
  );
}
