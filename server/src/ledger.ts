import type { DB } from './db.ts';
import { LOW_STOCK_THRESHOLD, PROFIT_SHARES } from './settings.ts';
import { UNMATCHED_PREFIX, UNCHECKED_PREFIX, REVIEW_PREFIX } from './taobao.ts';

/**
 * 账户余额 = 生意在这个账户里的钱。
 * 公共资金：正数就是现金余额。
 * 个人账户：负数表示此人垫付、待公共资金还给他；正数表示此人代收了生意的钱、待上交。
 * 淘宝销售在买家确认收货前钱没到账（received = 0），不计入余额，算「淘宝应收」；它的退款同理。
 */
export function accountBalances(db: DB) {
  const rows = db
    .prepare(
      `SELECT a.id, a.kind, a.name, a.user_id, COALESCE(SUM(m.delta), 0) AS balance
       FROM accounts a
       LEFT JOIN (
         SELECT account_id AS acc,
                CASE type WHEN 'purchase' THEN -amount WHEN 'expense' THEN -amount WHEN 'transfer' THEN -amount
                          WHEN 'sale_return' THEN -amount ELSE amount END AS delta
         FROM docs d
         WHERE status = 'active' AND account_id IS NOT NULL
           AND type IN ('purchase', 'sale', 'sale_return', 'expense', 'income', 'transfer', 'opening_balance')
           AND NOT (type = 'sale' AND COALESCE(received, 1) = 0)
           AND NOT (type = 'sale_return' AND COALESCE((SELECT received FROM docs s WHERE s.id = d.ref_doc_id), 1) = 0)
         UNION ALL
         SELECT to_account_id, amount FROM docs WHERE status = 'active' AND type = 'transfer'
       ) m ON m.acc = a.id
       GROUP BY a.id
       ORDER BY a.kind DESC, a.id`,
    )
    .all() as { id: number; kind: string; name: string; user_id: number | null; balance: number }[];
  return rows;
}

/** 结算建议：把每个个人账户与公共资金结清 */
export function settleSuggestions(db: DB) {
  const accs = accountBalances(db);
  const pub = accs.find((a) => a.kind === 'public')!;
  return accs
    .filter((a) => a.kind === 'person' && a.balance !== 0)
    .map((a) =>
      a.balance < 0
        ? { from_account_id: pub.id, from_name: pub.name, to_account_id: a.id, to_name: a.name, amount: -a.balance, label: `还 ${a.name} 垫付` }
        : { from_account_id: a.id, from_name: a.name, to_account_id: pub.id, to_name: pub.name, amount: a.balance, label: `${a.name} 上交代收款` },
    );
}

function sum(db: DB, sql: string, params: (string | number)[]): number {
  const r = db.prepare(sql).get(...params) as { v: number | null };
  return r.v ?? 0;
}

/** 利润表；month 形如 2026-09，不传为累计 */
export function profit(db: DB, month?: string) {
  const dateCond = month ? `AND d.doc_date LIKE ?` : '';
  const p = month ? [`${month}%`] : [];

  const sales = sum(
    db,
    `SELECT SUM(CASE type WHEN 'sale' THEN amount ELSE -amount END) v FROM docs d
     WHERE status = 'active' AND type IN ('sale', 'sale_return') ${dateCond}`,
    p,
  );
  // 淘宝订单里没对上商品的行（未匹配 SKU / 待核对实发 / 同步后待确认）连同这单的邮费：先不计入销售额和成本，确认后随重建计入
  const pendingLines = sum(
    db,
    `SELECT SUM(j.amount) v FROM doc_adjustments j JOIN docs d ON d.id = j.doc_id
     WHERE d.status = 'active' AND d.type = 'sale' AND d.review = 'unmatched'
       AND (j.name LIKE '${UNMATCHED_PREFIX}%' OR j.name LIKE '${UNCHECKED_PREFIX}%' OR j.name LIKE '${REVIEW_PREFIX}%' OR j.name = '邮费') ${dateCond}`,
    p,
  );
  // 这些行上发生的退款（不关联商品的「退款：…」）同样先不计
  const pendingRefunds = sum(
    db,
    `SELECT SUM(j.amount) v FROM doc_adjustments j JOIN docs d ON d.id = j.doc_id JOIN docs s ON s.id = d.ref_doc_id
     WHERE d.status = 'active' AND d.type = 'sale_return' AND s.review = 'unmatched' AND j.name LIKE '退款：%' ${dateCond}`,
    p,
  );
  const pending = {
    amount: pendingLines - pendingRefunds,
    orders: sum(db, `SELECT COUNT(*) v FROM docs d WHERE status = 'active' AND type = 'sale' AND review = 'unmatched' ${dateCond}`, p),
  };
  // 销售额 = 销售 − 退款 − 没对上的行；退货单按退货日期计入当月
  const revenue = sales - pending.amount;
  const itemSum = (type: string, expr: string) =>
    sum(
      db,
      `SELECT SUM(${expr}) v FROM doc_items i JOIN docs d ON d.id = i.doc_id WHERE d.status = 'active' AND d.type = '${type}' ${dateCond}`,
      p,
    );
  // 卖出成本扣掉退回入库的成本
  const cogs = itemSum('sale', 'i.cost_amount') - itemSum('sale_return', 'i.cost_amount');
  const costPendingUnits = itemSum('sale', 'i.cost_pending');
  const outboundCost = itemSum('outbound', 'i.cost_amount');
  const stocktakeLoss = itemSum('stocktake', 'CASE WHEN i.qty < 0 THEN i.cost_amount ELSE -i.cost_amount END');

  const byCat = (type: string) =>
    db
      .prepare(
        `SELECT category, SUM(amount) AS amount FROM docs d WHERE status = 'active' AND type = ? ${dateCond} GROUP BY category ORDER BY amount DESC`,
      )
      .all(type, ...p) as { category: string; amount: number }[];
  // 进货单上的运费 / 优惠已按金额比例摊进商品成本（进价 = 实付），这里不再单独算
  const expenseByCat = byCat('expense');
  const expenses = expenseByCat.reduce((s, r) => s + r.amount, 0);
  const incomeByCat = byCat('income');
  const otherIncome = incomeByCat.filter((r) => r.category !== '追加投资').reduce((s, r) => s + r.amount, 0);
  const investment = incomeByCat.filter((r) => r.category === '追加投资').reduce((s, r) => s + r.amount, 0);

  const net = revenue - cogs - expenses - outboundCost - stocktakeLoss + otherIncome;
  const users = db.prepare('SELECT username, name FROM users').all() as { username: string; name: string }[];
  const shares = Object.entries(PROFIT_SHARES).map(([username, ratio]) => ({
    name: users.find((u) => u.username === username)?.name ?? username,
    ratio,
    amount: Math.round(net * ratio),
  }));

  return {
    revenue,
    cogs,
    cost_pending_units: costPendingUnits,
    gross: revenue - cogs,
    expenses,
    expense_by_category: expenseByCat,
    outbound_cost: outboundCost,
    stocktake_loss: stocktakeLoss,
    other_income: otherIncome,
    pending,
    investment,
    net,
    shares,
  };
}

export function inventorySummary(db: DB) {
  const s = db
    .prepare(
      `SELECT COUNT(*) AS products,
              COALESCE(SUM(CASE WHEN stock_qty > 0 THEN stock_qty END), 0) AS units,
              COALESCE(SUM(stock_value), 0) AS value
       FROM products`,
    )
    .get() as { products: number; units: number; value: number };
  const negative = db
    .prepare('SELECT id, name, spec, stock_qty FROM products WHERE stock_qty < 0 ORDER BY stock_qty')
    .all();
  // 只提示有过进出记录的商品，避免刚建档还没进货的商品刷屏
  const low = db
    .prepare(
      `SELECT id, name, spec, stock_qty FROM products p
       WHERE stock_qty >= 0 AND stock_qty <= ? AND EXISTS (SELECT 1 FROM doc_items i WHERE i.product_id = p.id)
       ORDER BY stock_qty, name LIMIT 30`,
    )
    .all(LOW_STOCK_THRESHOLD);
  return { ...s, negative, low };
}

/** 投入本金：期初资金 + 期初垫付（个人账户期初为负数，取反）+ 追加投资 */
export function capital(db: DB): number {
  return sum(
    db,
    `SELECT SUM(CASE WHEN d.type = 'opening_balance' AND a.kind = 'person' THEN -d.amount ELSE d.amount END) v
     FROM docs d JOIN accounts a ON a.id = d.account_id
     WHERE d.status = 'active' AND (d.type = 'opening_balance' OR (d.type = 'income' AND d.category = '追加投资'))`,
    [],
  );
}

/** 淘宝应收：已发货、买家还没确认收货的销售额（扣掉这些单的退款） */
export function receivable(db: DB, overdueDays = 10) {
  const rows = db
    .prepare(
      `SELECT d.id, d.doc_date, d.source_ref, d.amount,
              COALESCE((SELECT SUM(r.amount) FROM docs r WHERE r.ref_doc_id = d.id AND r.type = 'sale_return' AND r.status = 'active'), 0) AS refunded
       FROM docs d WHERE d.status = 'active' AND d.type = 'sale' AND d.received = 0 ORDER BY d.doc_date, d.id`,
    )
    .all() as { id: number; doc_date: string; source_ref: string; amount: number; refunded: number }[];
  const cutoff = new Date(Date.now() - overdueDays * 86400000).toISOString().slice(0, 10);
  const items = rows.map((r) => ({ ...r, due: r.amount - r.refunded, overdue: r.doc_date <= cutoff }));
  return {
    amount: items.reduce((s, r) => s + r.due, 0),
    count: items.length,
    overdue_count: items.filter((r) => r.overdue).length,
    items,
  };
}
