import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Dialog, List, NavBar, Popup, Tag, Toast } from 'antd-mobile';
import { api, DOC_LABEL, get, money, type DocType, type TaobaoOrder } from '../api';
import { useSession } from '../store';
import ProductsEditor, { pickedToInput, type PickedProduct, type Suggestion } from '../components/ProductsEditor';

interface Sub {
  sub_no: string;
  item_id: string;
  sku: string;
  label: string;
  title: string;
  qty: number;
  paid: number;
  status: string;
  refund_status: string;
  refund: number;
  shipped_at: string | null;
  /** 这个 SKU 对照的商品（买 1 件发几件） */
  products: PickedProduct[];
  /** 还没对照时，系统给的候选 */
  suggestions: Suggestion[];
}

interface OrderDetail {
  order: TaobaoOrder & { created_at: string | null; pending: boolean };
  subs: Sub[];
  actual: { custom: boolean; rows: PickedProduct[]; text: string };
  remark_suggestions: Suggestion[];
  docs: { id: number; type: DocType; doc_date: string; amount: number; status: string; review: string; received: number | null }[];
  logs: { created_at: string; detail: string; user_name: string | null }[];
  /** 有货已经退回来了：不能再改实发 */
  returned: boolean;
}

/** 按下单 SKU 对照算出来的发货商品（改实发时的起点） */
function orderedProducts(subs: Sub[]): PickedProduct[] {
  const out = new Map<number, PickedProduct>();
  for (const s of subs) {
    if (s.refund_status === '退款成功' && !s.shipped_at) continue;
    for (const p of s.products) {
      const cur = out.get(p.product_id);
      out.set(p.product_id, { ...p, qty: (cur?.qty ?? 0) + p.qty * s.qty });
    }
  }
  return [...out.values()];
}

export default function TaobaoOrderPage() {
  const { no } = useParams();
  const nav = useNavigate();
  const { refreshMeta } = useSession();
  const [data, setData] = useState<OrderDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [skuEditing, setSkuEditing] = useState<Sub | null>(null);

  const load = useCallback(async () => setData(await get<OrderDetail>(`/api/taobao/orders/${no}`)), [no]);
  useEffect(() => {
    load().catch((e) => Toast.show(e.message));
  }, [load]);

  if (!data) return null;
  const { order: o, subs, actual } = data;
  const shipped = subs.some((s) => s.shipped_at);

  const save = async (body: Record<string, unknown>, done: string) => {
    const r = await api<{ result: { rebuilt_sales: number[]; errors: string[] } }>('PUT', `/api/taobao/orders/${no}/actual`, body);
    if (r.result.errors.length) Toast.show({ content: r.result.errors.join('；'), icon: 'fail' });
    else Toast.show(r.result.rebuilt_sales.length ? `${done}，销售单已按新实发重建` : done);
    refreshMeta();
    await load();
  };

  const run = async (content: string, body: Record<string, unknown>, done: string) => {
    if (!(await Dialog.confirm({ content }))) return;
    try {
      await save(body, done);
    } catch (e: any) {
      Toast.show({ content: e.message, icon: 'fail' });
    }
  };

  return (
    <div className="page">
      <NavBar onBack={() => nav(-1)}>淘宝订单</NavBar>
      <div className="card">
        <div className="fund-main">
          <span>{o.order_no}</span>
          <b>{money(o.paid)}</b>
        </div>
        <div className="muted small">
          {o.status}
          {o.postage > 0 && ` · 邮费 ${money(o.postage)}`}
        </div>
        <div className="muted small">
          {[o.paid_at && `付款 ${o.paid_at.slice(5, 16)}`, o.shipped_at && `发货 ${o.shipped_at.slice(5, 16)}`, o.confirmed_at && `收货 ${o.confirmed_at.slice(5, 16)}`]
            .filter(Boolean)
            .join(' · ')}
        </div>
        {o.remark && <div className="warn-text">备注：{o.remark}</div>}
      </div>

      <List header="下单">
        {subs.map((s) => (
          <List.Item
            key={s.sub_no}
            description={
              <>
                <div className="ellipsis">{s.title}</div>
                {s.products.length ? (
                  <div>对照 → {s.products.map((p) => `${p.name}${p.qty > 1 ? ` ×${p.qty}` : ''}`).join(' + ')}</div>
                ) : (
                  <div className="warn-text">
                    没对上商品，这行不扣库存、不算利润
                    {s.suggestions[0] && `；最像：${s.suggestions[0].name}（${Math.round(s.suggestions[0].score * 100)}%）`}
                    <Button size="mini" color="primary" fill="outline" style={{ marginLeft: 6 }} onClick={() => setSkuEditing(s)}>
                      对照
                    </Button>
                  </div>
                )}
                {s.refund > 0 && <div className="down">{s.refund_status} {money(s.refund)}</div>}
              </>
            }
            extra={money(s.paid)}
          >
            {s.label || '（无规格）'} ×{s.qty}
          </List.Item>
        ))}
      </List>

      <div className="section-title">实际发出</div>
      <div className="card">
        <div>
          <b>{actual.text}</b>
          {o.pending && (
            <Tag color="warning" fill="outline" style={{ marginLeft: 6 }}>
              {o.actual_state === 'draft' ? '草稿，未生效' : '有备注，待核对'}
            </Tag>
          )}
        </div>
        <div className="muted small" style={{ margin: '6px 0 10px' }}>
          只有这里的商品扣库存、算成本；销售额照样按买家实付全额算。刷单发空包、改发别的都在这里改{shipped ? '' : '，还没发货也可以先填好'}。
        </div>
        {data.returned ? (
          <div className="warn-text small">这个订单有货已经退回来了，要改实发先作废那张退货单。</div>
        ) : (
          <div className="btn-row">
            <Button size="small" color="primary" onClick={() => setEditing(true)}>
              改实发商品
            </Button>
            <Button size="small" fill="outline" onClick={() => run('这单是空包（没寄东西）？库存不扣，销售额照算。', { items: [] }, '已改成空包')}>
              空包
            </Button>
            {(actual.custom || o.pending) && (
              <Button size="small" fill="outline" onClick={() => run('就按下单的商品发的？', { as_ordered: true }, '已改回按下单发')}>
                按下单发
              </Button>
            )}
          </div>
        )}
      </div>

      {data.docs.length > 0 && (
        <List header="生成的单据">
          {data.docs.map((d) => (
            <List.Item
              key={d.id}
              arrow
              onClick={() => nav(`/docs/${d.id}`)}
              extra={<span className={d.status === 'void' ? 'voided' : d.type === 'sale_return' ? 'down' : ''}>{money(d.amount)}</span>}
            >
              {d.doc_date} {DOC_LABEL[d.type]}
              {d.status === 'void' && <Tag color="default" style={{ marginLeft: 6 }}>已作废</Tag>}
              {d.status === 'active' && d.type === 'sale' && d.received === 0 && <Tag color="warning" fill="outline" style={{ marginLeft: 6 }}>未到账</Tag>}
              {d.status === 'active' && d.review === 'pending' && <Tag color="danger" fill="outline" style={{ marginLeft: 6 }}>待确认</Tag>}
            </List.Item>
          ))}
        </List>
      )}

      {data.logs.length > 0 && (
        <List header="实发修改记录">
          {data.logs.map((l, i) => {
            const d = JSON.parse(l.detail);
            return (
              <List.Item key={i} description={`${l.created_at.slice(5, 16)} · ${l.user_name ?? ''}${d.draft ? ' · 草稿' : ''}`}>
                {d.before} → {d.after}
              </List.Item>
            );
          })}
        </List>
      )}

      <Popup visible={editing} onMaskClick={() => setEditing(false)} bodyStyle={{ maxHeight: '85vh', overflow: 'auto' }} destroyOnClose>
        <ProductsEditor
          title={`订单 ${o.order_no} 实发`}
          hint={
            <>
              {o.remark && (
                <>
                  备注：<b>{o.remark}</b>
                  <br />
                </>
              )}
              下单：{subs.map((s) => `${s.label || s.title} ×${s.qty}`).join('、')}
              <br />
              填实际寄出的商品，什么都不加就是空包；售价按商品参考价比例分摊。
            </>
          }
          initial={actual.custom ? actual.rows : orderedProducts(subs)}
          suggestions={[...data.remark_suggestions, ...subs.flatMap((s) => s.suggestions)].filter(
            (x, i, all) => all.findIndex((y) => (y.product_id ?? -y.catalog_id!) === (x.product_id ?? -x.catalog_id!)) === i,
          )}
          allowEmpty
          onClose={() => setEditing(false)}
          onSave={(items) => save({ items: pickedToInput(items) }, '已保存实发')}
        />
      </Popup>

      <Popup visible={!!skuEditing} onMaskClick={() => setSkuEditing(null)} bodyStyle={{ maxHeight: '85vh', overflow: 'auto' }} destroyOnClose>
        {skuEditing && (
          <ProductsEditor
            title={skuEditing.label || skuEditing.title}
            hint={
              <>
                {skuEditing.title}
                <br />
                买家拍 1 件对应发出哪些商品、各几件（套装就加多个）。以后同一个 SKU 的订单都按这个对照。
              </>
            }
            initial={[]}
            suggestions={skuEditing.suggestions}
            onClose={() => setSkuEditing(null)}
            onSave={async (items) => {
              const r = await api<{ result: { rebuilt_sales: number[]; errors: string[] } }>('PUT', '/api/taobao/sku-map', {
                item_id: skuEditing.item_id,
                sku: skuEditing.sku,
                items: pickedToInput(items),
              });
              Toast.show(r.result.rebuilt_sales.length ? `已对照，${r.result.rebuilt_sales.length} 张销售单补上了商品` : '已对照');
              refreshMeta();
              await load();
            }}
          />
        )}
      </Popup>
    </div>
  );
}
