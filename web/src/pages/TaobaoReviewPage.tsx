import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, Empty, NavBar, Popup, Tag, Toast } from 'antd-mobile';
import { api, get, money, post } from '../api';
import { useSession } from '../store';
import ProductsEditor, { pickedToInput, type PickedProduct } from '../components/ProductsEditor';
import { orderedProducts, type OrderDetail, type Sub } from './TaobaoOrderPage';

interface Review extends OrderDetail {
  /** 这期间的变化（每次同步一行） */
  changes: string[];
  review_at: string;
  /** 不能直接确认的原因（SKU 没对上 / 备注没核对） */
  issue: string | null;
}

const shippedOf = (r: Review) => r.subs.filter((s) => s.shipped_at);

/** 这单扣了（或发货后要扣）哪些库存 */
function Consumption({ r }: { r: Review }) {
  const { order: o, actual } = r;
  const shipped = shippedOf(r).length > 0;
  if (o.pending) return <div className="warn-text">有商家备注，实发还没核对：先不扣库存</div>;
  const rows: PickedProduct[] = actual.custom ? actual.rows : orderedProducts(shipped ? shippedOf(r) : r.subs);
  const text = actual.custom && !rows.length ? '空包，不扣库存' : rows.map((p) => `${p.name} ×${p.qty}`).join('、') || '—';
  return (
    <div>
      <span className="muted">{shipped ? '扣库存：' : '还没发货，发货后扣：'}</span>
      <b>{text}</b>
      {actual.custom && <Tag color="primary" fill="outline" style={{ marginLeft: 6 }}>改过实发</Tag>}
    </div>
  );
}

export default function TaobaoReviewPage() {
  const nav = useNavigate();
  const { refreshMeta } = useSession();
  const [items, setItems] = useState<Review[] | null>(null);
  const [editing, setEditing] = useState<Review | null>(null);
  const [skuEditing, setSkuEditing] = useState<{ r: Review; s: Sub } | null>(null);

  const load = useCallback(async () => setItems((await get<{ items: Review[] }>('/api/taobao/reviews')).items), []);
  useEffect(() => {
    load().catch((e) => Toast.show(e.message));
  }, [load]);

  const after = async () => {
    refreshMeta();
    await load();
  };
  const fail = (e: any) => Toast.show({ content: e.message, icon: 'fail' });

  const confirm = async (no: string) => {
    try {
      await post(`/api/taobao/reviews/${no}/confirm`);
      Toast.show({ content: '已确认', icon: 'success' });
      await after();
    } catch (e) {
      fail(e);
    }
  };

  /** 改实发 = 人已经看过这单了：保存后顺手确认 */
  const saveActual = async (no: string, body: Record<string, unknown>) => {
    const r = await api<{ result: { errors: string[] } }>('PUT', `/api/taobao/orders/${no}/actual`, body);
    if (r.result.errors.length) Toast.show({ content: r.result.errors.join('；'), icon: 'fail' });
    await post(`/api/taobao/reviews/${no}/confirm`).catch(fail);
    await after();
  };
  const quick = async (no: string, content: string, body: Record<string, unknown>) => {
    if (!(await Dialog.confirm({ content }))) return;
    await saveActual(no, body).catch(fail);
  };

  const refundOnly = async (docId: number) => {
    if (!(await Dialog.confirm({ content: '只退了钱、货没退回来？库存不变。' }))) return;
    try {
      await post(`/api/docs/${docId}/refund-only`);
      await after();
    } catch (e) {
      fail(e);
    }
  };

  const confirmAll = async (n: number) => {
    if (!(await Dialog.confirm({ content: `${n} 单都按下面显示的扣库存，确认？` }))) return;
    try {
      const r = await post<{ confirmed: number; left: number }>('/api/taobao/reviews/confirm-all');
      Toast.show(r.left ? `确认了 ${r.confirmed} 单，还剩 ${r.left} 单要处理` : `确认了 ${r.confirmed} 单`);
      await after();
    } catch (e) {
      fail(e);
    }
  };

  if (!items) return null;
  const clean = items.filter((r) => !r.issue).length;

  return (
    <div className="page">
      <NavBar onBack={() => nav(-1)}>同步待确认</NavBar>
      {!items.length ? (
        <>
          <Empty description="都确认完了，可以再同步订单了" />
          <div style={{ padding: '0 16px' }}>
            <Button block color="primary" fill="outline" onClick={() => nav('/plugin', { replace: true })}>
              去同步订单
            </Button>
          </div>
        </>
      ) : (
        <div className="card">
          <div className="muted small">
            上次同步后新发货（要扣库存）或发货后退款的 {items.length} 单。逐单看扣了哪些库存，不对就改实发；SKU 没对上的在这里直接对照；退款的确认货有没有退回来。全部确认完才能再同步。
          </div>
          {clean > 0 && (
            <Button block color="primary" style={{ marginTop: 10 }} onClick={() => confirmAll(clean)}>
              没问题的 {clean} 单一键确认
            </Button>
          )}
        </div>
      )}

      {items.map((r) => {
        const o = r.order;
        return (
          <div className="card review-card" key={o.order_no}>
            <div className="fund-main" onClick={() => nav(`/taobao/orders/${o.order_no}`)}>
              <span>{o.order_no} ›</span>
              <b>{money(o.paid)}</b>
            </div>
            <div className="muted small">{o.status}</div>
            {r.changes.map((c, i) => (
              <div key={i} className="small">
                <Tag color="warning" fill="outline">
                  {c.startsWith('新订单') ? '新' : '变'}
                </Tag>{' '}
                {c}
              </div>
            ))}
            {o.remark && <div className="warn-text small">备注：{o.remark}</div>}

            <div className="review-subs">
              {r.subs.map((s) => (
                <div key={s.sub_no} className="small">
                  <div>
                    {s.label || s.title} ×{s.qty} · {money(s.paid)}
                    {s.refund > 0 && <span className="down"> · {s.refund_status} {money(s.refund)}</span>}
                  </div>
                  {s.products.length ? (
                    <div className="muted">→ {s.products.map((p) => `${p.name}${p.qty > 1 ? ` ×${p.qty}` : ''}`).join(' + ')}</div>
                  ) : (
                    <div className="warn-text">
                      没对上库存商品
                      {s.suggestions[0] && `，最像：${s.suggestions[0].name}`}
                      <Button size="mini" color="primary" style={{ marginLeft: 6 }} onClick={() => setSkuEditing({ r, s })}>
                        对照
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <Consumption r={r} />
            {r.docs
              .filter((d) => d.type === 'sale_return' && d.review === 'pending' && d.status === 'active')
              .map((d) => (
                <div key={d.id} className="review-refund">
                  <div>
                    <span className="down">退款 {money(d.amount)}</span>：货退回来了吗？
                  </div>
                  <div className="btn-row" style={{ marginTop: 6 }}>
                    <Button size="mini" color="primary" onClick={() => nav(`/docs/${d.ref_doc_id}/return?replace=${d.id}&back=review`)}>
                      货退回来了（入库）
                    </Button>
                    <Button size="mini" fill="outline" onClick={() => refundOnly(d.id)}>
                      只退了钱
                    </Button>
                  </div>
                </div>
              ))}
            {r.issue && <div className="warn-text small">{r.issue}</div>}

            <div className="btn-row" style={{ marginTop: 10 }}>
              <Button size="small" color="primary" disabled={!!r.issue} onClick={() => confirm(o.order_no)}>
                确认
              </Button>
              {!r.returned && (
                <>
                  <Button size="small" fill="outline" onClick={() => setEditing(r)}>
                    改实发
                  </Button>
                  <Button size="small" fill="outline" onClick={() => quick(o.order_no, '这单是空包（没寄东西）？库存不扣，销售额照算。', { items: [] })}>
                    空包
                  </Button>
                  {(r.actual.custom || o.pending) && (
                    <Button size="small" fill="outline" onClick={() => quick(o.order_no, '就按下单的商品发的？', { as_ordered: true })}>
                      按下单发
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}

      <Popup visible={!!editing} onMaskClick={() => setEditing(null)} bodyStyle={{ maxHeight: '85vh', overflow: 'auto' }} destroyOnClose>
        {editing && (
          <ProductsEditor
            title={`订单 ${editing.order.order_no} 实发`}
            hint={
              <>
                {editing.order.remark && (
                  <>
                    备注：<b>{editing.order.remark}</b>
                    <br />
                  </>
                )}
                下单：{editing.subs.map((s) => `${s.label || s.title} ×${s.qty}`).join('、')}
                <br />
                填实际寄出的商品和件数（扣的就是这些库存），什么都不加就是空包。保存后这单同时确认。
              </>
            }
            initial={editing.actual.custom ? editing.actual.rows : orderedProducts(editing.subs)}
            suggestions={[...editing.remark_suggestions, ...editing.subs.flatMap((s) => s.suggestions)].filter(
              (x, i, all) => all.findIndex((y) => (y.product_id ?? -y.catalog_id!) === (x.product_id ?? -x.catalog_id!)) === i,
            )}
            allowEmpty
            onClose={() => setEditing(null)}
            onSave={(items) => saveActual(editing.order.order_no, { items: pickedToInput(items) })}
          />
        )}
      </Popup>

      <Popup visible={!!skuEditing} onMaskClick={() => setSkuEditing(null)} bodyStyle={{ maxHeight: '85vh', overflow: 'auto' }} destroyOnClose>
        {skuEditing && (
          <ProductsEditor
            title={skuEditing.s.label || skuEditing.s.title}
            hint={
              <>
                {skuEditing.s.title}
                <br />
                买家拍 1 件对应发出哪些商品、各几件（套装就加多个）。以后同一个 SKU 的订单都按这个对照。
              </>
            }
            initial={[]}
            suggestions={skuEditing.s.suggestions}
            saveText="保存对照"
            onClose={() => setSkuEditing(null)}
            onSave={async (items) => {
              const r = await api<{ result: { rebuilt_sales: number[] } }>('PUT', '/api/taobao/sku-map', {
                item_id: skuEditing.s.item_id,
                sku: skuEditing.s.sku,
                items: pickedToInput(items),
              });
              Toast.show(r.result.rebuilt_sales.length ? `已对照，${r.result.rebuilt_sales.length} 张销售单补上了商品` : '已对照');
              await after();
            }}
          />
        )}
      </Popup>
    </div>
  );
}
