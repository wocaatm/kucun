import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Dialog, Empty, List, NavBar, Popup, Tabs, Tag, Toast } from 'antd-mobile';
import { api, get, money, post, type TaobaoOrder } from '../api';
import { useSession } from '../store';
import ProductsEditor, { type PickedProduct } from '../components/ProductsEditor';


interface Sku {
  item_id: string;
  sku: string;
  label: string;
  title: string;
  lines: number;
  qty: number;
  waiting: number;
  state: 'none' | 'auto' | 'confirmed';
  products: PickedProduct[];
}

interface ActualOrder extends TaobaoOrder {
  subs: { sub_no: string; label: string; title: string; qty: number; paid: number; status: string }[];
  actual: PickedProduct[];
}

interface ToShip extends TaobaoOrder {
  subs: { sub_no: string; label: string; qty: number; paid: number; products: PickedProduct[] }[];
}

interface Overview {
  status: {
    unmatched_orders: number;
    unmatched_amount: number;
    unchecked_orders: number;
    to_ship: number;
    unconfirmed_sku: number;
    pending_refunds: number;
    last_import: string | null;
  };
  receivable: {
    amount: number;
    count: number;
    overdue_count: number;
    items: { id: number; doc_date: string; source_ref: string; amount: number; refunded: number; due: number; overdue: boolean }[];
  };
  skus: Sku[];
  actual: ActualOrder[];
  unmatched: { id: number; doc_date: string; source_ref: string; amount: number; remark: string | null; lines: { name: string; amount: number }[] }[];
  to_ship: ToShip[];
  pending_refunds: { id: number; doc_date: string; amount: number; source_ref: string; item_summary: string }[];
}

interface Report {
  orders: number;
  sub_orders: number;
  created_sales: number[];
  rebuilt_sales: number[];
  received: number;
  refunds: number[];
  auto_mapped: number;
  unmatched_orders: number;
  unmatched_amount: number;
  to_ship: number;
  errors: string[];
  negative: { id: number; name: string; stock_qty: number }[];
}

const SKU_STATE: Record<Sku['state'], { text: string; color: string }> = {
  none: { text: '未对照', color: 'danger' },
  auto: { text: '自动匹配·待确认', color: 'warning' },
  confirmed: { text: '已确认', color: 'success' },
};

const productsText = (ps: PickedProduct[]) => ps.map((p) => `${p.name}${p.qty > 1 ? ` ×${p.qty}` : ''}`).join(' + ');

function ImportTab({ onDone }: { onDone: () => void }) {
  const nav = useNavigate();
  const { refreshMeta } = useSession();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ dry: boolean; report: Report } | null>(null);

  const run = async (dry: boolean) => {
    if (files.length < 2) return void Toast.show('请选上主订单表和子订单表两个文件');
    setBusy(true);
    try {
      const fd = new FormData();
      files.forEach((f, i) => fd.append(`file${i}`, f, f.name));
      fd.append('dry', dry ? '1' : '0');
      const r = await api<{ dry: boolean; report: Report }>('POST', '/api/taobao/import', fd);
      setResult(r);
      if (!dry) {
        refreshMeta();
        onDone();
      }
    } catch (e: any) {
      Toast.show({ content: e.message, icon: 'fail' });
    } finally {
      setBusy(false);
    }
  };

  const r = result?.report;
  return (
    <div>
      <div className="card">
        <div className="muted small">
          千牛 → 订单 → 导出「订单列表」的两张表：主订单表和子订单表（宝贝明细），勾选全部字段。两张都选上，顺序随意。每天导一次，重复导入是安全的。
        </div>
        <input
          ref={input}
          type="file"
          accept=".xlsx"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            setFiles([...(e.target.files ?? [])].slice(0, 2));
            setResult(null);
          }}
        />
        <Button block onClick={() => input.current?.click()} style={{ marginTop: 12 }}>
          {files.length ? files.map((f) => f.name).join('、') : '选择两个 Excel 文件'}
        </Button>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <Button fill="outline" loading={busy} onClick={() => run(true)}>
            先试跑看看
          </Button>
          <Button color="primary" loading={busy} onClick={() => run(false)}>
            导入
          </Button>
        </div>
      </div>
      {r && (
        <div className="card">
          <div className="card-title">{result!.dry ? '试跑结果（没有保存）' : '导入完成'}</div>
          <div className="kv-list">
            <div>
              <span>主订单 / 子订单</span>
              <b>
                {r.orders} / {r.sub_orders}
              </b>
            </div>
            <div>
              <span>新生成销售单（已发货）</span>
              <b>{r.created_sales.length}</b>
            </div>
            <div>
              <span>标记到账（交易成功）</span>
              <b>{r.received}</b>
            </div>
            <div>
              <span>发货后退款（待确认）</span>
              <b>{r.refunds.length}</b>
            </div>
            {r.rebuilt_sales.length > 0 && (
              <div>
                <span>补全商品后重建</span>
                <b>{r.rebuilt_sales.length}</b>
              </div>
            )}
            <div>
              <span>自动匹配的新 SKU（待确认）</span>
              <b>{r.auto_mapped}</b>
            </div>
            <div>
              <span>有商品没对上的订单（没扣库存）</span>
              <b className={r.unmatched_orders ? 'down' : ''}>
                {r.unmatched_orders}
                {r.unmatched_orders ? ` · ${money(r.unmatched_amount)}` : ''}
              </b>
            </div>
            <div>
              <span>待发货</span>
              <b>{r.to_ship}</b>
            </div>
          </div>
          {r.errors.length > 0 && <div className="warn-text small">{r.errors.join('；')}</div>}
          {r.negative.length > 0 && (
            <div className="stock-alert neg">
              <div className="alert-title">负库存（卖出多于进货，请盘点或补录进货）</div>
              {r.negative.map((p) => (
                <div key={p.id} onClick={() => nav(`/products/${p.id}`)}>
                  <span>{p.name}</span>
                  <b>{p.stock_qty}</b>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TaobaoPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'todo';
  const { refreshMeta } = useSession();
  const [data, setData] = useState<Overview | null>(null);
  const [editor, setEditor] = useState<React.ReactNode>(null);

  const load = useCallback(async () => setData(await get<Overview>('/api/taobao/overview')), []);
  useEffect(() => {
    load().catch((e) => Toast.show(e.message));
  }, [load]);

  const afterChange = (r: { result: { rebuilt_sales: number[]; errors: string[] } }) => {
    const n = r.result.rebuilt_sales.length;
    Toast.show(n ? `已确认，${n} 张销售单补上了商品、扣了库存` : '已确认');
    if (r.result.errors.length) Toast.show({ content: r.result.errors.join('；'), icon: 'fail' });
    refreshMeta();
    load();
  };

  const editSku = (s: Sku) =>
    setEditor(
      <ProductsEditor
        title={s.label || s.title}
        hint={
          <>
            {s.title}
            <br />
            买家拍 1 件对应发出哪些商品、各几件（套装就加多个）
          </>
        }
        initial={s.products}
        onClose={() => setEditor(null)}
        onSave={async (items) =>
          afterChange(
            await api('PUT', '/api/taobao/sku-map', {
              item_id: s.item_id,
              sku: s.sku,
              items: items.map((i) => ({ product_id: i.product_id, qty: i.qty })),
            }),
          )
        }
      />,
    );

  const editActual = (o: ActualOrder) =>
    setEditor(
      <ProductsEditor
        title={`订单 ${o.order_no}`}
        hint={
          <>
            备注：<b>{o.remark}</b>
            <br />
            下单：{o.subs.map((s) => `${s.label} ×${s.qty}`).join('、')}
            <br />
            填实际发出的商品；售价按商品参考价比例分摊。
          </>
        }
        initial={o.actual}
        onClose={() => setEditor(null)}
        extra={
          <Button
            block
            fill="none"
            style={{ marginTop: 8 }}
            onClick={async () => {
              const ok = await Dialog.confirm({ content: '备注和实发无关，就按下单的商品发的？' });
              if (!ok) return;
              try {
                afterChange(await api('PUT', `/api/taobao/orders/${o.order_no}/actual`, { as_ordered: true }));
                setEditor(null);
              } catch (e: any) {
                Toast.show({ content: e.message, icon: 'fail' });
              }
            }}
          >
            按下单的商品发（备注和实发无关）
          </Button>
        }
        onSave={async (items) =>
          afterChange(
            await api('PUT', `/api/taobao/orders/${o.order_no}/actual`, {
              items: items.map((i) => ({ product_id: i.product_id, qty: i.qty })),
            }),
          )
        }
      />,
    );

  const confirmAll = async () => {
    const ok = await Dialog.confirm({ content: `把 ${data!.status.unconfirmed_sku} 个自动匹配的 SKU 全部确认？确认前建议逐个看一眼。` });
    if (!ok) return;
    afterChange(await post('/api/taobao/sku-map/confirm-all'));
  };

  const st = data?.status;
  const todoCount = st ? st.unmatched_orders + st.pending_refunds : 0;

  return (
    <div className="page">
      <NavBar onBack={() => nav(-1)}>淘宝订单</NavBar>
      <Tabs activeKey={tab} onChange={(k) => setParams({ tab: k }, { replace: true })}>
        <Tabs.Tab title={<Badge content={todoCount || null}>待办</Badge>} key="todo" />
        <Tabs.Tab title="导入" key="import" />
        <Tabs.Tab title="SKU 对照" key="sku" />
        <Tabs.Tab title="应收" key="due" />
        <Tabs.Tab title="待发货" key="ship" />
      </Tabs>

      {tab === 'import' && <ImportTab onDone={load} />}

      {data && tab === 'todo' && (
        <>
          <div className="muted small tb-last">上次导入：{st!.last_import ?? '还没导入过'}</div>
          {todoCount === 0 && <Empty description="没有待办" />}
          {data.unmatched.length > 0 && (
            <List header={`有商品没对上的订单：只记了金额 ${money(st!.unmatched_amount)}，没扣库存、没算成本`}>
              {data.unmatched.map((u) => (
                <List.Item
                  key={u.id}
                  arrow
                  onClick={() => nav(`/docs/${u.id}`)}
                  description={
                    <>
                      {u.lines.map((l) => (
                        <div key={l.name}>
                          {l.name} · {money(l.amount)}
                        </div>
                      ))}
                      {u.remark && <div className="warn-text">备注：{u.remark}</div>}
                    </>
                  }
                  extra={money(u.amount)}
                >
                  {u.source_ref} · 发货 {u.doc_date.slice(5)}
                </List.Item>
              ))}
            </List>
          )}
          {data.skus.some((s) => s.state !== 'confirmed' && s.waiting > 0) && (
            <List header="要对照的 SKU（点开选对应商品，确认后上面的订单自动补扣库存）">
              {data.skus
                .filter((s) => s.state !== 'confirmed' && s.waiting > 0)
                .map((s) => (
                  <SkuRow key={s.item_id + s.sku} s={s} onClick={() => editSku(s)} />
                ))}
            </List>
          )}
          {data.actual.length > 0 && (
            <List header="有商家备注的订单：核对实际发了什么（确认后才扣库存）">
              {data.actual.map((o) => (
                <List.Item
                  key={o.order_no}
                  arrow
                  onClick={() => editActual(o)}
                  description={
                    <>
                      <div>下单：{o.subs.map((s) => `${s.label} ×${s.qty}`).join('、')}</div>
                      {o.actual.length > 0 && <div>实发{o.actual_state === 'draft' ? '（草稿）' : ''}：{productsText(o.actual)}</div>}
                    </>
                  }
                  extra={
                    <Tag color={o.actual_state === 'confirmed' ? 'success' : o.actual_state === 'draft' ? 'warning' : 'danger'} fill="outline">
                      {o.actual_state === 'confirmed' ? '已确认' : o.actual_state === 'draft' ? '草稿待确认' : '待填'}
                    </Tag>
                  }
                >
                  {o.remark}
                </List.Item>
              ))}
            </List>
          )}
          {data.pending_refunds.length > 0 && (
            <List header="发货后退款：货退回来了吗？">
              {data.pending_refunds.map((r) => (
                <List.Item
                  key={r.id}
                  arrow
                  onClick={() => nav(`/docs/${r.id}`)}
                  description={`${r.source_ref} · ${r.item_summary}`}
                  extra={<span className="down">-{money(r.amount)}</span>}
                >
                  {r.doc_date} 退款
                </List.Item>
              ))}
            </List>
          )}
        </>
      )}

      {data && tab === 'sku' && (
        <>
          {st!.unconfirmed_sku > 0 && (
            <div style={{ padding: '12px 16px 0' }}>
              <Button block color="primary" fill="outline" onClick={confirmAll}>
                全部确认自动匹配（{st!.unconfirmed_sku} 个）
              </Button>
            </div>
          )}
          <List>
            {data.skus.map((s) => (
              <SkuRow key={s.item_id + s.sku} s={s} onClick={() => editSku(s)} />
            ))}
          </List>
          {!data.skus.length && <Empty description="还没导入过订单" />}
        </>
      )}

      {data && tab === 'due' && (
        <>
          <div className="card">
            <div className="fund-main">
              <span>淘宝应收（已发货、买家未确认收货）</span>
              <b>{money(data.receivable.amount)}</b>
            </div>
            <div className="muted small">
              {data.receivable.count} 单
              {data.receivable.overdue_count > 0 && <span className="down">，其中 {data.receivable.overdue_count} 单发货超过 10 天</span>}
            </div>
          </div>
          <List>
            {data.receivable.items.map((r) => (
              <List.Item
                key={r.id}
                arrow
                onClick={() => nav(`/docs/${r.id}`)}
                description={`${r.source_ref}${r.refunded ? ` · 已退 ${money(r.refunded)}` : ''}`}
                extra={<span className={r.overdue ? 'down' : ''}>{money(r.due)}</span>}
              >
                <span className={r.overdue ? 'down' : ''}>发货 {r.doc_date}</span>
              </List.Item>
            ))}
          </List>
        </>
      )}

      {data && tab === 'ship' && (
        <>
          {!data.to_ship.length && <Empty description="没有待发货的订单" />}
          <List>
            {data.to_ship.map((o) => (
              <List.Item
                key={o.order_no}
                description={
                  <>
                    {o.subs.map((s) => (
                      <div key={s.sub_no}>
                        {s.label} ×{s.qty}
                        {s.products.length > 0 && <span className="muted"> → {productsText(s.products)}（库存 {s.products.map((p) => p.stock_qty).join('/')}）</span>}
                      </div>
                    ))}
                    {o.remark && <div className="warn-text">备注：{o.remark}</div>}
                  </>
                }
                extra={money(o.paid)}
              >
                付款 {o.paid_at?.slice(5, 16)}
              </List.Item>
            ))}
          </List>
        </>
      )}

      <Popup visible={!!editor} onMaskClick={() => setEditor(null)} bodyStyle={{ maxHeight: '85vh', overflow: 'auto' }} destroyOnClose>
        {editor}
      </Popup>
    </div>
  );
}

function SkuRow({ s, onClick }: { s: Sku; onClick: () => void }) {
  const st = SKU_STATE[s.state];
  return (
    <List.Item
      arrow
      onClick={onClick}
      description={
        <>
          <div className="ellipsis">{s.title}</div>
          <div>{s.products.length ? `→ ${productsText(s.products)}` : '→ 未对应商品'}</div>
          <div>
            卖出 {s.qty} 件{s.waiting > 0 ? ` · ${s.waiting} 行没扣库存` : ''}
          </div>
        </>
      }
      extra={
        <Tag color={st.color} fill="outline">
          {st.text}
        </Tag>
      }
    >
      {s.label || '（无规格）'}
    </List.Item>
  );
}
