import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Image, List, NavBar, SearchBar, Tag, Toast } from 'antd-mobile';
import { DOC_LABEL, get, money, productImage, SOURCE_LABEL, type CatalogItem, type DocType, type Product } from '../api';
import ProductForm from '../components/ProductForm';
import { CatalogRow, catalogToProduct } from '../components/ProductPicker';

interface Move {
  id: number;
  doc_id: number;
  type: DocType;
  category: string;
  doc_date: string;
  status: string;
  qty: number;
  unit_price: number;
  cost_amount: number;
  cost_pending: number;
  created_by_name: string;
}

interface Purchase {
  doc_id: number;
  type: DocType;
  doc_date: string;
  counterparty: string;
  channel: string;
  qty: number;
  /** 这一行的实付成本（优惠 / 运费已摊入） */
  cost: number;
  account_name: string | null;
}

export function ProductEditPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [product, setProduct] = useState<Product | null>(null);
  useEffect(() => {
    if (id) get(`/api/products/${id}`).then((r) => setProduct(r.product));
  }, [id]);
  const [q, setQ] = useState('');
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  useEffect(() => {
    if (id) return;
    const t = setTimeout(() => {
      if (q.trim()) get<{ items: CatalogItem[] }>(`/api/catalog?q=${encodeURIComponent(q)}`).then((r) => setCatalog(r.items));
      else setCatalog([]);
    }, 250);
    return () => clearTimeout(t);
  }, [q, id]);

  if (id && !product) return null;
  const barcode = params.get('barcode');
  return (
    <div className="page">
      <NavBar onBack={() => nav(-1)}>{id ? '编辑商品' : '新建商品'}</NavBar>
      {!id && (
        <>
          <div className="section-title">从奥乐齐商品库选（点一下即建档）</div>
          <div style={{ padding: '0 12px 8px' }}>
            <SearchBar placeholder="搜奥乐齐商品名 / 货号 / 品牌" value={q} onChange={setQ} />
          </div>
          {catalog.length > 0 && (
            <List>
              {catalog.map((c) => (
                <CatalogRow
                  key={c.id}
                  c={c}
                  onClick={async () => {
                    try {
                      const p = await catalogToProduct(c, barcode);
                      Toast.show({ content: c.product_id ? '已建过档，打开商品' : '已建档', icon: 'success' });
                      nav(`/products/${p.id}`, { replace: true });
                    } catch (e: any) {
                      Toast.show({ content: e.message, icon: 'fail' });
                    }
                  }}
                />
              ))}
            </List>
          )}
          <div className="section-title">或者手动填写</div>
        </>
      )}
      <ProductForm
        initial={product ?? { barcode: params.get('barcode') ?? '' }}
        onSaved={(p) => nav(`/products/${p.id}`, { replace: true })}
      />
    </div>
  );
}

export default function ProductDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState<{ product: Product; moves: Move[]; purchases: Purchase[] } | null>(null);

  useEffect(() => {
    get(`/api/products/${id}`).then(setData);
  }, [id]);

  if (!data) return null;
  const p = data.product;
  const moveQty = (m: Move) => (m.type === 'sale' || m.type === 'outbound' ? -m.qty : m.qty);

  return (
    <div className="page">
      <NavBar onBack={() => nav(-1)} right={<Button size="small" fill="none" onClick={() => nav(`/products/${id}/edit`)}>编辑</Button>}>
        商品详情
      </NavBar>
      <div className="card product-head">
        {productImage(p) && <Image src={productImage(p)!} width={72} height={72} fit="cover" style={{ borderRadius: 8, flexShrink: 0 }} />}
        <div>
          <div className="product-name">{p.name}</div>
          <div className="muted">{[p.spec, p.category].filter(Boolean).join(' · ')}</div>
          <div className="muted small">
            {[p.barcode ? `条码 ${p.barcode}` : '未绑条码', p.sku_code ? `货号 ${p.sku_code}` : '', p.brand, p.source ? `来自${SOURCE_LABEL[p.source] ?? p.source}` : '']
              .filter(Boolean)
              .join(' · ')}
          </div>
          {p.note && <div className="muted small">{p.note}</div>}
        </div>
      </div>
      <div className="card stat-row">
        <div>
          <b className={p.stock_qty < 0 ? 'down' : ''}>{p.stock_qty}</b>
          <span>当前库存</span>
        </div>
        <div>
          <b>{money(p.avg_cost)}</b>
          <span>平均成本</span>
        </div>
        <div>
          <b>{money(p.ref_price)}</b>
          <span>参考售价</span>
        </div>
      </div>
      <div className="editor-buttons" style={{ padding: '0 12px' }}>
        <Button color="primary" fill="outline" onClick={() => nav(`/new/purchase?product=${id}`)}>
          进货
        </Button>
        <Button color="primary" fill="outline" onClick={() => nav(`/new/sale?product=${id}`)}>
          卖出
        </Button>
        <Button fill="outline" onClick={() => nav(`/new/stocktake?product=${id}`)}>
          盘点
        </Button>
      </div>
      {data.purchases.length > 0 && (
        <List header={`进货记录 · 实付单价（优惠、运费已摊入）· 最近进价 ${money(Math.round(data.purchases[0].cost / data.purchases[0].qty))}`}>
          {data.purchases.map((x, i) => (
            <List.Item
              key={`${x.doc_id}-${i}`}
              onClick={() => nav(`/docs/${x.doc_id}`)}
              description={[x.type === 'opening_stock' ? '期初库存' : '', x.counterparty || x.channel, x.account_name ? `${x.account_name}付` : '']
                .filter(Boolean)
                .join(' · ')}
              extra={
                <span>
                  {x.qty} 件 × <b>{money(Math.round(x.cost / x.qty))}</b>
                </span>
              }
            >
              {x.doc_date}
            </List.Item>
          ))}
        </List>
      )}
      <List header="出入库记录">
        {data.moves.map((m) => (
          <List.Item
            key={m.id}
            onClick={() => nav(`/docs/${m.doc_id}`)}
            description={`${m.doc_date} · ${m.created_by_name}${
              m.type === 'purchase' || m.type === 'opening_stock'
                ? ` · 进价 ${money(m.unit_price)}`
                : m.type === 'sale'
                  ? ` · 售价 ${money(m.unit_price)} · 成本 ${m.cost_pending ? '待定' : money(m.cost_amount)}`
                  : ''
            }`}
            extra={<b className={moveQty(m) < 0 ? 'down' : 'up'}>{moveQty(m) > 0 ? `+${moveQty(m)}` : moveQty(m)}</b>}
          >
            {DOC_LABEL[m.type]}
            {m.category ? ` · ${m.category}` : ''}
            {m.status === 'void' && (
              <Tag color="default" style={{ marginLeft: 6 }}>
                已作废
              </Tag>
            )}
          </List.Item>
        ))}
      </List>
    </div>
  );
}
