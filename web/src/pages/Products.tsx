import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, CapsuleTabs, Empty, List, NavBar, SearchBar, Toast } from 'antd-mobile';
import { AddOutline, ScanningOutline, UploadOutline } from 'antd-mobile-icons';
import { get, money, productImage, type CatalogItem, type Product } from '../api';
import { StockTag, Thumb, catalogToProduct } from '../components/ProductPicker';
import Scanner from '../components/Scanner';

export default function Products() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Product[] | null>(null);
  const [scan, setScan] = useState(false);
  const filter = params.get('filter') ?? '';

  useEffect(() => {
    const t = setTimeout(() => {
      get<{ items: Product[] }>(`/api/products?q=${encodeURIComponent(q)}&filter=${filter}`).then((r) => setItems(r.items));
    }, 200);
    return () => clearTimeout(t);
  }, [q, filter]);

  const onScan = async (code: string) => {
    const r = await get<{ product: Product | null; catalog: CatalogItem | null }>(`/api/products/barcode/${encodeURIComponent(code)}`);
    const product = r.product ?? (r.catalog ? await catalogToProduct(r.catalog) : null);
    if (product) nav(`/products/${product.id}`);
    else {
      Toast.show(`条码 ${code} 未登记，搜一下商品名建档`);
      nav(`/products/new?barcode=${encodeURIComponent(code)}`);
    }
  };

  return (
    <div className="page tab-page">
      <NavBar
        back={null}
        right={
          <div className="nav-actions">
            <UploadOutline onClick={() => nav('/products/import')} />
            <AddOutline onClick={() => nav('/products/new')} />
          </div>
        }
      >
        商品
      </NavBar>
      <div className="search-row">
        <SearchBar placeholder="搜索名称 / 条码 / 分类" value={q} onChange={setQ} style={{ flex: 1 }} />
        <Button fill="none" onClick={() => setScan(true)}>
          <ScanningOutline fontSize={22} />
        </Button>
      </div>
      <CapsuleTabs activeKey={filter} onChange={(k) => setParams(k ? { filter: k } : {})}>
        <CapsuleTabs.Tab title="全部" key="" />
        <CapsuleTabs.Tab title="有库存" key="instock" />
        <CapsuleTabs.Tab title="负库存" key="negative" />
      </CapsuleTabs>
      {items && !items.length ? (
        <Empty description={q ? '已建档商品里没有，点右上角 + 可从奥乐齐商品库建档' : '还没有商品，点右上角 + 新建（可从奥乐齐商品库选）'} />
      ) : (
        <List>
          {items?.map((p) => (
            <List.Item
              key={p.id}
              onClick={() => nav(`/products/${p.id}`)}
              prefix={<Thumb src={productImage(p)} name={p.name} />}
              description={[p.spec, p.category, p.avg_cost != null ? `均价 ${money(p.avg_cost)}` : null].filter(Boolean).join(' · ')}
              extra={<StockTag qty={p.stock_qty} />}
            >
              {p.name}
            </List.Item>
          ))}
        </List>
      )}
      <Scanner visible={scan} onClose={() => setScan(false)} onDetected={onScan} title="扫码查商品" />
    </div>
  );
}
