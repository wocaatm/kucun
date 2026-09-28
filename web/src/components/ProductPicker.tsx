import { useEffect, useState } from 'react';
import { Button, List, NoticeBar, Popup, SearchBar, Tag, Toast } from 'antd-mobile';
import { AddOutline } from 'antd-mobile-icons';
import { get, money, post, productImage, SOURCE_LABEL, type CatalogItem, type Product } from '../api';
import ProductForm from './ProductForm';

interface Props {
  visible: boolean;
  onClose: () => void;
  onPick: (p: Product) => void;
  /** 打开时预填的搜索词和新建时的默认名称 */
  initialQuery?: string;
  candidates?: Product[];
  catalogCandidates?: CatalogItem[];
  /** 新建商品时预填的条码（识别结果里带的） */
  newBarcode?: string | null;
  /** 扫到未登记条码时：选中已有商品就把这个条码绑定上去 */
  bindBarcode?: string | null;
}

export function StockTag({ qty }: { qty: number }) {
  return (
    <Tag color={qty < 0 ? 'danger' : qty === 0 ? 'default' : 'primary'} fill="outline">
      库存 {qty}
    </Tag>
  );
}

export function Thumb({ src, name }: { src: string | null; name: string }) {
  return src ? <img className="thumb" src={src} loading="lazy" /> : <div className="thumb thumb-empty">{name.slice(0, 1)}</div>;
}

export function CatalogRow({ c, onClick }: { c: CatalogItem; onClick: () => void }) {
  return (
    <List.Item
      onClick={onClick}
      prefix={<Thumb src={c.image_url} name={c.name} />}
      description={[c.category, c.sku_code ? `货号 ${c.sku_code}` : ''].filter(Boolean).join(' · ')}
      extra={
        c.product_id ? (
          <Tag color="primary" fill="outline">
            已建档
          </Tag>
        ) : (
          <Tag color="success" fill="outline">
            点选建档
          </Tag>
        )
      }
    >
      {c.name}
    </List.Item>
  );
}

/** 参考库商品 → 商品（已建档直接返回，未建档就建） */
export async function catalogToProduct(c: CatalogItem, barcode?: string | null): Promise<Product> {
  const r = await post<{ product: Product }>('/api/products', { catalog_id: c.id, barcode: barcode ?? undefined });
  return r.product;
}

export default function ProductPicker({ visible, onClose, onPick, initialQuery = '', candidates, catalogCandidates, newBarcode, bindBarcode }: Props) {
  const [q, setQ] = useState(initialQuery);
  const [list, setList] = useState<Product[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (visible) {
      setQ(initialQuery);
      setCreating(false);
    }
  }, [visible, initialQuery]);

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      get<{ items: Product[] }>(`/api/products?q=${encodeURIComponent(q)}&limit=30`).then((r) => setList(r.items));
      if (q.trim()) get<{ items: CatalogItem[] }>(`/api/catalog?q=${encodeURIComponent(q)}`).then((r) => setCatalog(r.items));
      else setCatalog([]);
    }, 250);
    return () => clearTimeout(t);
  }, [q, visible]);

  const pick = async (p: Product) => {
    try {
      if (bindBarcode && !p.barcode) {
        const r = await post<{ product: Product }>(`/api/products/${p.id}/barcode`, { barcode: bindBarcode });
        p = r.product;
        Toast.show({ content: '已绑定条码，下次扫码直接识别', icon: 'success' });
      }
      onPick(p);
      onClose();
    } catch (e: any) {
      Toast.show({ content: e.message, icon: 'fail' });
    }
  };

  const pickCatalog = async (c: CatalogItem) => {
    try {
      const p = await catalogToProduct(c, bindBarcode ?? newBarcode);
      if (!c.product_id) Toast.show({ content: '已从奥乐齐商品库建档', icon: 'success' });
      onPick(p);
      onClose();
    } catch (e: any) {
      Toast.show({ content: e.message, icon: 'fail' });
    }
  };

  // 候选里去掉已在搜索结果中的，避免重复
  const catalogShown = [
    ...(catalogCandidates ?? []).filter((c) => !catalog.some((x) => x.id === c.id)),
    ...catalog,
  ];

  return (
    <Popup visible={visible} onMaskClick={onClose} bodyStyle={{ height: '88vh', borderRadius: '16px 16px 0 0' }} destroyOnClose>
      {creating ? (
        <div className="popup-scroll">
          <div className="popup-title">
            新建商品
            <Button size="small" fill="none" onClick={() => setCreating(false)}>
              返回
            </Button>
          </div>
          <ProductForm initial={{ name: q, barcode: bindBarcode ?? newBarcode ?? '' }} onSaved={(p) => (onPick(p), onClose())} submitText="保存并选择" />
        </div>
      ) : (
        <div className="popup-scroll">
          <div className="popup-title">{bindBarcode ? '这个条码是哪个商品？' : '选择商品'}</div>
          {bindBarcode && (
            <NoticeBar wrap color="info" content={`条码 ${bindBarcode}：搜名称找到商品后点一下，会自动绑定条码，下次扫码直接识别`} />
          )}
          <div style={{ padding: '8px 12px' }}>
            <SearchBar placeholder="名称 / 条码 / 货号 / 品牌" value={q} onChange={setQ} />
          </div>
          {!!candidates?.length && (
            <List header="可能是">
              {candidates.map((p) => (
                <List.Item key={p.id} onClick={() => pick(p)} description={p.spec} extra={<StockTag qty={p.stock_qty} />}>
                  {p.name}
                </List.Item>
              ))}
            </List>
          )}
          <List header={q ? '我的商品' : '最近商品'}>
            {list.map((p) => (
              <List.Item
                key={p.id}
                onClick={() => pick(p)}
                prefix={<Thumb src={productImage(p)} name={p.name} />}
                description={[p.spec, p.barcode ?? p.sku_code, p.avg_cost != null ? `均价 ${money(p.avg_cost)}` : ''].filter(Boolean).join(' · ')}
                extra={<StockTag qty={p.stock_qty} />}
              >
                {p.name}
              </List.Item>
            ))}
            {q && !list.length && <List.Item disabled>没有已建档的商品</List.Item>}
          </List>
          {catalogShown.length > 0 && (
            <List header={`${SOURCE_LABEL[catalogShown[0].source] ?? ''}商品库（点一下即建档）`}>
              {catalogShown.map((c) => (
                <CatalogRow key={c.id} c={c} onClick={() => pickCatalog(c)} />
              ))}
            </List>
          )}
          <List>
            <List.Item prefix={<AddOutline />} onClick={() => setCreating(true)} arrow>
              都不是，新建商品{q ? `「${q}」` : ''}
            </List.Item>
          </List>
        </div>
      )}
    </Popup>
  );
}
