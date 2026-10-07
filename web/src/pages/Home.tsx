import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, PullToRefresh, Skeleton, Toast } from 'antd-mobile';
import { LeftOutline, RightOutline } from 'antd-mobile-icons';
import dayjs from 'dayjs';
import { get, money, post, type Account } from '../api';
import { useSession } from '../store';

interface Profit {
  revenue: number;
  cogs: number;
  cost_pending_units: number;
  gross: number;
  expenses: number;
  expense_by_category: { category: string; amount: number }[];
  outbound_cost: number;
  stocktake_loss: number;
  other_income: number;
  /** 没对上商品的淘宝订单行：暂不计入销售额和成本 */
  pending: { amount: number; orders: number };
  investment: number;
  net: number;
  shares: { name: string; ratio: number; amount: number }[];
}

interface Settle {
  from_account_id: number;
  to_account_id: number;
  from_name: string;
  to_name: string;
  amount: number;
  label: string;
}

interface Dashboard {
  month: string;
  accounts: Account[];
  settle: Settle[];
  capital: number;
  month_profit: Profit;
  total_profit: Profit;
  inventory: {
    products: number;
    units: number;
    value: number;
    negative: { id: number; name: string; spec: string; stock_qty: number }[];
    low: { id: number; name: string; spec: string; stock_qty: number }[];
  };
  receivable: { amount: number; count: number; overdue_count: number };
  taobao: {
    unmatched_orders: number;
    unmatched_amount: number;
    unchecked_orders: number;
    to_ship: number;
    unconfirmed_sku: number;
    pending_refunds: number;
    reviews: number;
    last_import: string | null;
  };
}

const QUICK = [
  { label: '扫码进货', icon: '📦', to: '/new/purchase?scan=1' },
  { label: '扫码卖出', icon: '🛍️', to: '/new/sale?scan=1' },
  { label: '拍小票', icon: '🧾', to: '/new/purchase' },
  { label: '记支出', icon: '💸', to: '/money/expense' },
];

/** 营业额提示：有淘宝订单的商品没对上，这部分暂不计入销售额和成本 */
function UnmatchedHint({ pending, light }: { pending: Profit['pending']; light?: boolean }) {
  const nav = useNavigate();
  if (!pending.orders) return null;
  return (
    <div className={`unmatched-hint ${light ? 'light' : ''}`} onClick={() => nav('/taobao?tab=todo')}>
      ⚠️ 另有 {pending.orders} 单淘宝订单的部分商品没对上（{money(pending.amount)}），暂不计入销售额和成本，对上后自动计入。点这里处理 ›
    </div>
  );
}

function ProfitRows({ p }: { p: Profit }) {
  const loss = p.outbound_cost + p.stocktake_loss;
  return (
    <div className="kv-list">
      <div>
        <span>销售额</span>
        <b>{money(p.revenue)}</b>
      </div>
      <UnmatchedHint pending={p.pending} light />
      <div>
        <span>卖出商品成本</span>
        <b>-{money(p.cogs)}</b>
      </div>
      <div className="kv-strong">
        <span>毛利</span>
        <b>{money(p.gross)}</b>
      </div>
      <div>
        <span>各项支出</span>
        <b>-{money(p.expenses)}</b>
      </div>
      {loss !== 0 && (
        <div>
          <span>损耗 / 自用 / 盘点差异</span>
          <b>{loss > 0 ? '-' : '+'}{money(Math.abs(loss))}</b>
        </div>
      )}
      {p.other_income !== 0 && (
        <div>
          <span>其他收入</span>
          <b>+{money(p.other_income)}</b>
        </div>
      )}
      <div className="kv-strong">
        <span>净利润</span>
        <b className={p.net >= 0 ? 'up' : 'down'}>{money(p.net)}</b>
      </div>
      {p.expense_by_category.length > 0 && (
        <div className="kv-sub">
          支出：{p.expense_by_category.map((c) => `${c.category} ${money(c.amount)}`).join('，')}
        </div>
      )}
      <div className="kv-sub">商品成本按实付算：进货单上的优惠、运费已按金额比例摊进每个商品</div>
      {p.cost_pending_units > 0 && (
        <div className="kv-sub warn-text">有 {p.cost_pending_units} 件商品先卖后买、还没进货，成本暂按 0 计，利润偏高</div>
      )}
    </div>
  );
}

function TaobaoCard({ data }: { data: Dashboard }) {
  const nav = useNavigate();
  const t = data.taobao;
  const r = data.receivable;
  const todos = [
    t.reviews > 0 && { text: `${t.reviews} 单同步后待确认`, to: '/taobao/review' },
    t.unmatched_orders > 0 && { text: `${t.unmatched_orders} 单有商品没对上`, to: '/taobao?tab=todo' },
    t.unconfirmed_sku > 0 && { text: `${t.unconfirmed_sku} 个 SKU 待确认`, to: '/taobao?tab=sku' },
    t.unchecked_orders > 0 && { text: `${t.unchecked_orders} 单要核对实发`, to: '/taobao?tab=todo' },
    t.pending_refunds > 0 && { text: `${t.pending_refunds} 笔退款待确认`, to: '/taobao?tab=todo' },
    t.to_ship > 0 && { text: `${t.to_ship} 单待发货`, to: '/taobao?tab=orders&group=to_ship' },
  ].filter(Boolean) as { text: string; to: string }[];
  if (!t.last_import && !r.count) return null;
  return (
    <div className="card">
      <div className="card-title">
        淘宝
        <span className="muted" onClick={() => nav('/taobao?tab=import')}>
          导入订单 ›
        </span>
      </div>
      <div className="fund-main" onClick={() => nav('/taobao?tab=due')}>
        <span>应收（已发货待确认收货 {r.count} 单）</span>
        <b>{money(r.amount)}</b>
      </div>
      {r.overdue_count > 0 && <div className="down small">{r.overdue_count} 单发货超过 10 天还没确认收货</div>}
      {todos.length > 0 && (
        <div className="tb-todos">
          {todos.map((x) => (
            <span key={x.text} onClick={() => nav(x.to)}>
              {x.text}
            </span>
          ))}
        </div>
      )}
      <div className="muted small">上次导入 {t.last_import?.slice(5, 16) ?? '—'}</div>
    </div>
  );
}

export default function Home() {
  const nav = useNavigate();
  const { user, refreshMeta } = useSession();
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'));
  const [data, setData] = useState<Dashboard | null>(null);

  const load = useCallback(async () => {
    setData(await get<Dashboard>(`/api/dashboard?month=${month}`));
  }, [month]);

  useEffect(() => {
    load().catch((e) => Toast.show(e.message));
  }, [load]);

  const settle = async (s: Settle) => {
    const ok = await Dialog.confirm({
      title: s.label,
      content: (
        <div className="confirm-body">
          <div>
            {s.from_name} → {s.to_name}
          </div>
          <b style={{ fontSize: 22 }}>{money(s.amount)}</b>
          <div className="muted small">确认钱已经实际转过去了吗？</div>
        </div>
      ),
      confirmText: '已转，记一笔',
    });
    if (!ok) return;
    await post('/api/docs', {
      type: 'transfer',
      account_id: s.from_account_id,
      to_account_id: s.to_account_id,
      amount: s.amount,
      note: s.label,
    });
    Toast.show({ content: '已结清', icon: 'success' });
    refreshMeta();
    load();
  };

  if (!data) {
    return (
      <div className="page tab-page">
        <Skeleton.Title animated />
        <Skeleton.Paragraph lineCount={8} animated />
      </div>
    );
  }

  const mp = data.month_profit;
  const tp = data.total_profit;
  const pub = data.accounts.find((a) => a.kind === 'public')!;
  const persons = data.accounts.filter((a) => a.kind === 'person');
  const isCurrent = month === dayjs().format('YYYY-MM');

  return (
    <PullToRefresh onRefresh={load}>
      <div className="page tab-page home">
        <div className="hero">
          <div className="hero-top">
            <span>你好，{user?.name}</span>
            <div className="month-switch">
              <LeftOutline onClick={() => setMonth(dayjs(month).subtract(1, 'month').format('YYYY-MM'))} />
              <span>{dayjs(month).format('YYYY年M月')}</span>
              <RightOutline
                className={isCurrent ? 'disabled' : ''}
                onClick={() => !isCurrent && setMonth(dayjs(month).add(1, 'month').format('YYYY-MM'))}
              />
            </div>
          </div>
          <div className="hero-label">本月净利润</div>
          <div className="hero-value">{money(mp.net)}</div>
          <div className="hero-row">
            <div>
              <span>销售额</span>
              <b>{money(mp.revenue)}</b>
            </div>
            <div>
              <span>毛利</span>
              <b>{money(mp.gross)}</b>
            </div>
            <div>
              <span>支出</span>
              <b>{money(mp.expenses)}</b>
            </div>
          </div>
          <UnmatchedHint pending={mp.pending} />
          <div className="hero-shares">
            {mp.shares.map((s) => (
              <span key={s.name}>
                {s.name} 应得 <b>{money(s.amount)}</b>
              </span>
            ))}
          </div>
        </div>

        <div className="quick-grid">
          {QUICK.map((q) => (
            <div key={q.label} className="quick-item" onClick={() => nav(q.to)}>
              <span className="quick-icon">{q.icon}</span>
              <span>{q.label}</span>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-title">
            资金
            <span className="muted">投入本金 {money(data.capital)}</span>
          </div>
          <div className="fund-main">
            <span>公共资金余额</span>
            <b className={pub.balance < 0 ? 'down' : ''}>{money(pub.balance)}</b>
          </div>
          <div className="person-grid">
            {persons.map((a) => (
              <div key={a.id} className="person-cell">
                <span className="person-name">{a.name}</span>
                {a.balance === 0 ? (
                  <span className="muted">已结清</span>
                ) : a.balance < 0 ? (
                  <span className="down">垫付 {money(-a.balance)}</span>
                ) : (
                  <span className="up">代收 {money(a.balance)}</span>
                )}
              </div>
            ))}
          </div>
          {data.settle.length > 0 && (
            <div className="settle-list">
              <div className="muted small">建议结算（实际转完钱后点一下）</div>
              {data.settle.map((s) => (
                <div key={`${s.from_account_id}-${s.to_account_id}`} className="settle-item">
                  <span>
                    {s.from_name} → {s.to_name} <b>{money(s.amount)}</b>
                  </span>
                  <Button size="mini" color="primary" fill="outline" onClick={() => settle(s)}>
                    已转
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <TaobaoCard data={data} />

        <div className="card">
          <div className="card-title">库存</div>
          <div className="stat-row">
            <div onClick={() => nav('/products')}>
              <b>{data.inventory.products}</b>
              <span>商品</span>
            </div>
            <div onClick={() => nav('/products?filter=instock')}>
              <b>{data.inventory.units}</b>
              <span>在库件数</span>
            </div>
            <div>
              <b>{money(data.inventory.value)}</b>
              <span>库存成本</span>
            </div>
          </div>
          {data.inventory.negative.length > 0 && (
            <div className="stock-alert neg">
              <div className="alert-title">负库存（先卖后买，待进货）</div>
              {data.inventory.negative.map((p) => (
                <div key={p.id} onClick={() => nav(`/products/${p.id}`)}>
                  <span>
                    {p.name} {p.spec}
                  </span>
                  <b>{p.stock_qty}</b>
                </div>
              ))}
            </div>
          )}
          {data.inventory.low.length > 0 && (
            <div className="stock-alert low">
              <div className="alert-title">库存不多了</div>
              {data.inventory.low.map((p) => (
                <div key={p.id} onClick={() => nav(`/products/${p.id}`)}>
                  <span>
                    {p.name} {p.spec}
                  </span>
                  <b>{p.stock_qty}</b>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title">{dayjs(month).format('M月')}经营</div>
          <ProfitRows p={mp} />
        </div>

        <div className="card">
          <div className="card-title">累计经营</div>
          <ProfitRows p={tp} />
          <div className="hero-shares light">
            {tp.shares.map((s) => (
              <span key={s.name}>
                {s.name} 累计应得 <b>{money(s.amount)}</b>
              </span>
            ))}
          </div>
        </div>
      </div>
    </PullToRefresh>
  );
}
