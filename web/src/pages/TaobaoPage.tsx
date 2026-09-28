import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, CapsuleTabs, Dialog, Empty, List, NavBar, Popup, SearchBar, Tabs, Tag, Toast } from 'antd-mobile';
import { api, get, money, post, type TaobaoOrder } from '../api';
import { useSession } from '../store';
import ProductsEditor, { pickedToInput, type PickedProduct, type Suggestion } from '../components/ProductsEditor';


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
  suggestions: Suggestion[];
}

interface ActualOrder extends TaobaoOrder {
  subs: { sub_no: string; label: string; title: string; qty: number; paid: number; status: string }[];
  actual: PickedProduct[];
}

interface ListedOrder extends TaobaoOrder {
  subs: { sub_no: string; label: string; title: string; qty: number; paid: number; refund_status: string; products: PickedProduct[] }[];
  actual_text: string;
}

const GROUPS = [
  { key: 'to_ship', title: '待发货' },
  { key: 'shipped', title: '已发货' },
  { key: 'success', title: '交易成功' },
  { key: 'closed', title: '已关闭' },
  { key: 'other', title: '其他' },
];

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
            {s.state === 'auto' && (
              <>
                <br />
                <b>下面是系统猜的，确认前不扣库存、不算利润。</b>
              </>
            )}
          </>
        }
        initial={s.products}
        suggestions={s.suggestions}
        onClose={() => setEditor(null)}
        onSave={async (items) =>
          afterChange(
            await api('PUT', '/api/taobao/sku-map', {
              item_id: s.item_id,
              sku: s.sku,
              items: pickedToInput(items),
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
        <Tabs.Tab title="订单" key="orders" />
        <Tabs.Tab title="导入" key="import" />
        <Tabs.Tab title="SKU 对照" key="sku" />
        <Tabs.Tab title="应收" key="due" />
      </Tabs>

      {tab === 'import' && <ImportTab onDone={load} />}
      {tab === 'orders' && <OrdersTab group={params.get('group') ?? 'shipped'} onGroup={(g) => setParams({ tab: 'orders', group: g }, { replace: true })} />}

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
                  onClick={() => nav(`/taobao/orders/${u.source_ref}`)}
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
                  onClick={() => nav(`/taobao/orders/${o.order_no}`)}
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

      <Popup visible={!!editor} onMaskClick={() => setEditor(null)} bodyStyle={{ maxHeight: '85vh', overflow: 'auto' }} destroyOnClose>
        {editor}
      </Popup>
    </div>
  );
}

function OrdersTab({ group, onGroup }: { group: string; onGroup: (g: string) => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ counts: Record<string, number>; items: ListedOrder[] } | null>(null);
  const [more, setMore] = useState(false);

  const load = useCallback(
    async (offset = 0) => {
      const r = await get<{ counts: Record<string, number>; items: ListedOrder[] }>(
        `/api/taobao/orders?group=${group}&q=${encodeURIComponent(q)}&offset=${offset}`,
      );
      setData((d) => (offset && d ? { counts: r.counts, items: [...d.items, ...r.items] } : r));
      setMore(r.items.length === 50);
    },
    [group, q],
  );
  useEffect(() => {
    load().catch((e) => Toast.show(e.message));
  }, [load]);

  return (
    <>
      <CapsuleTabs activeKey={group} onChange={onGroup}>
        {GROUPS.map((g) => (
          <CapsuleTabs.Tab key={g.key} title={`${g.title}${data?.counts[g.key] ? ` ${data.counts[g.key]}` : ''}`} />
        ))}
      </CapsuleTabs>
      <div style={{ padding: '0 12px 8px' }}>
        <SearchBar placeholder="搜订单号 / 商品 / 备注" onSearch={setQ} onClear={() => setQ('')} />
      </div>
      {data && !data.items.length && <Empty description="没有订单" />}
      <List>
        {data?.items.map((o) => (
          <List.Item
            key={o.order_no}
            arrow
            onClick={() => nav(`/taobao/orders/${o.order_no}`)}
            description={
              <>
                {o.subs.map((s) => (
                  <div key={s.sub_no}>
                    {s.label || s.title} ×{s.qty}
                    {s.refund_status === '退款成功' && <span className="down"> 已退款</span>}
                    {group === 'to_ship' && s.products.length > 0 && (
                      <span className="muted"> → {productsText(s.products)}（库存 {s.products.map((p) => p.stock_qty).join('/')}）</span>
                    )}
                  </div>
                ))}
                {o.actual_custom === 1 && <div>实发：{o.actual_text}</div>}
                {o.remark && <div className="warn-text">备注：{o.remark}</div>}
              </>
            }
            extra={money(o.paid)}
          >
            {(o.shipped_at ?? o.paid_at ?? '').slice(5, 16)} · {o.order_no.slice(-6)}
          </List.Item>
        ))}
      </List>
      {more && (
        <div style={{ padding: 12 }}>
          <Button block fill="none" onClick={() => load(data!.items.length)}>
            加载更多
          </Button>
        </div>
      )}
    </>
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
            {s.lines ? `卖出 ${s.qty} 件` : '还没卖过'}{s.waiting > 0 ? ` · ${s.waiting} 行没扣库存` : ''}
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
