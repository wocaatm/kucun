import type { DB } from './db.ts';

// 入库类单据：数量为正，按实付成本 in_cost（没有则按明细总价 amount）计成本（unit_price 只是展示用的标价均价）
export const IN_TYPES = new Set(['purchase', 'opening_stock']);
// 出库类单据：数量为正，按移动加权平均结转成本
const OUT_TYPES = new Set(['sale', 'outbound']);

interface ReplayRow {
  id: number;
  qty: number;
  unit_price: number;
  amount: number;
  in_cost: number | null;
  type: string;
}

interface Pending {
  itemId: number;
  units: number;
}

/**
 * 按单据日期（同一天按录入顺序）重放一个商品的全部有效明细，重新算出库存数量、库存金额，
 * 以及每条出库明细结转的成本。
 *
 * 允许负库存：库存不足时卖出的件数记为「成本待定」，
 * 等后续进货（或盘盈）到来时用那次的单价补上成本。
 * 作废任意单据后重放即可得到一致结果。
 */
export function replayProduct(db: DB, productId: number) {
  const rows = db
    .prepare(
      `SELECT i.id, i.qty, i.unit_price, i.amount, i.in_cost, d.type
       FROM doc_items i JOIN docs d ON d.id = i.doc_id
       WHERE i.product_id = ? AND d.status = 'active'
       ORDER BY d.doc_date, d.id, i.id`,
    )
    .all(productId) as unknown as ReplayRow[];

  let qty = 0;
  let value = 0;
  let lastCost: number | null = null;
  const pending: Pending[] = [];
  const cost = new Map<number, number>();
  const costPending = new Map<number, number>();

  /** 入库 n 件、总成本 total；总价除不尽时按件数比例分摊，分钱不丢 */
  const stockIn = (n: number, total: number) => {
    lastCost = Math.round(total / n);
    // 先给「成本待定」的卖出件补成本
    while (n > 0 && pending.length) {
      const p = pending[0];
      const k = Math.min(n, p.units);
      const c = k === n ? total : Math.round((total * k) / n);
      total -= c;
      cost.set(p.itemId, (cost.get(p.itemId) ?? 0) + c);
      costPending.set(p.itemId, (costPending.get(p.itemId) ?? 0) - k);
      p.units -= k;
      n -= k;
      qty += k;
      if (p.units === 0) pending.shift();
    }
    qty += n;
    value += total;
  };

  const stockOut = (itemId: number, n: number) => {
    const avail = Math.max(qty, 0);
    const k = Math.min(n, avail);
    const c = k === qty ? value : Math.round((value * k) / qty || 0);
    value -= c;
    qty -= k;
    cost.set(itemId, c);
    const r = n - k;
    costPending.set(itemId, r);
    if (r > 0) {
      qty -= r;
      pending.push({ itemId, units: r });
    }
  };

  for (const row of rows) {
    if (IN_TYPES.has(row.type)) {
      // 进货按实付成本入库（优惠 / 运费已按金额比例摊到每行，存在 in_cost）
      const c = row.in_cost ?? row.amount;
      if (row.qty > 0) stockIn(row.qty, c); // 入库数为 0 的进货行只记钱，不进库存
      cost.set(row.id, c);
      costPending.set(row.id, 0);
    } else if (OUT_TYPES.has(row.type)) {
      stockOut(row.id, row.qty);
    } else if (row.type === 'sale_return') {
      // 退货：退回的件数按填写的成本入库；仅退款（qty = 0）不动库存
      const c = row.qty > 0 ? (row.in_cost ?? 0) : 0;
      if (row.qty > 0) stockIn(row.qty, c);
      cost.set(row.id, c);
      costPending.set(row.id, 0);
    } else if (row.type === 'stocktake') {
      if (row.qty > 0) {
        // 盘盈按当前均价（没有则按最近进价）估值
        const unit = qty > 0 ? Math.round(value / qty) : (lastCost ?? 0);
        stockIn(row.qty, row.qty * unit);
        cost.set(row.id, row.qty * unit);
        costPending.set(row.id, 0);
      } else if (row.qty < 0) {
        stockOut(row.id, -row.qty);
      } else {
        cost.set(row.id, 0);
        costPending.set(row.id, 0);
      }
    }
  }

  const upd = db.prepare('UPDATE doc_items SET cost_amount = ?, cost_pending = ? WHERE id = ?');
  for (const row of rows) upd.run(cost.get(row.id) ?? 0, costPending.get(row.id) ?? 0, row.id);

  db.prepare(
    `UPDATE products SET stock_qty = ?, stock_value = ?, last_cost = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
  ).run(qty, qty > 0 ? value : 0, lastCost, productId);
}

export function avgCost(p: { stock_qty: number; stock_value: number; last_cost: number | null }): number | null {
  return p.stock_qty > 0 ? Math.round(p.stock_value / p.stock_qty) : p.last_cost;
}

/** 按权重把 total 拆成整数，合计不丢分 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  const out: number[] = [];
  let left = total;
  weights.forEach((w, i) => {
    const v = i === weights.length - 1 ? left : Math.round((total * w) / (sum || weights.length));
    out.push(v);
    left -= v;
  });
  return out;
}

/** 进货单每行的实付成本 = 标价 + 这单费用 / 减免按标价比例分摊 */
export function landedCosts(amounts: number[], adjustTotal: number): number[] {
  const shares = allocate(adjustTotal, amounts.map((a) => a || 0));
  return amounts.map((a, i) => Math.max(0, a + shares[i]));
}
