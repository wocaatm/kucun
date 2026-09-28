import type { DB } from './db.ts';
import { tx, log } from './db.ts';
import { createDoc, createReturn, voidDoc, BizError, normalizeName, today, type ItemInput } from './docs.ts';
import { productFromCatalog } from './catalog.ts';
import { allocate } from './inventory.ts';
import { FAKE_CATEGORY } from './settings.ts';
import { nameScore, titleScore, similarity } from './vision.ts';

/**
 * 淘宝订单导入（千牛导出的「订单列表」主订单表 + 子订单表）。
 *
 * - 子订单有发货时间 → 生成销售单（按主订单，一次发货一张），扣库存，钱记在公共资金但标「未到账」= 淘宝应收
 * - 主订单变成交易成功 → 销售单标「已到账」
 * - 发货后退款成功 → 自动生成「待处理退款」（仅退款），等人工确认货有没有退回
 * - 没发货就关闭 / 退款的子订单不生成任何单据
 * - 主订单有商家备注 → 先等人工核对实际发了什么（taobao_actual）再生成销售单
 * - SKU（商品ID + 规格）要先对照到库存商品（taobao_sku_map，套装可对多个商品），未确认的订单先不生成
 * 重复导入同一份数据是安全的：原始数据按订单号更新，已生成的单据不会重复生成。
 */

export const TB_SUCCESS = '交易成功';
export const TB_TO_SHIP = '买家已付款,等待卖家发货';
const REFUND_OK = '退款成功';

const fen = (s: string | undefined) => {
  const n = parseFloat(s ?? '');
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const time = (s: string | undefined) => (s && /^\d{4}-/.test(s) ? s : null);

export type SheetKind = 'orders' | 'items';

/** 按表头认出是主订单表还是子订单表 */
export function detectSheet(rows: Record<string, string>[]): SheetKind | null {
  const keys = new Set(Object.keys(rows[0] ?? {}));
  if (keys.has('子订单编号') && keys.has('主订单编号')) return 'items';
  if (keys.has('订单编号') && keys.has('买家应付邮费')) return 'orders';
  return null;
}

const SKU_PREFIX = /^商品规格[:：]/;
export const skuLabel = (sku: string) => sku.replace(SKU_PREFIX, '').trim();

function publicAccount(db: DB): number {
  return (db.prepare("SELECT id FROM accounts WHERE kind = 'public'").get() as { id: number }).id;
}

/** 分摊金额时用的商品权重：参考售价 → 当前均价 → 最近进价 */
function weightOf(db: DB, productId: number): number {
  const p = db.prepare('SELECT ref_price, stock_qty, stock_value, last_cost FROM products WHERE id = ?').get(productId) as any;
  const avg = p.stock_qty > 0 ? Math.round(p.stock_value / p.stock_qty) : null;
  return p.ref_price || avg || p.last_cost || 100;
}

export const split = allocate;

// ---------------------------------------------------------------- 写入原始数据

function upsertOrders(db: DB, rows: Record<string, string>[]) {
  const st = db.prepare(
    `INSERT INTO taobao_orders (order_no, status, paid, postage, payout, refund, created_at, paid_at, shipped_at, confirmed_at, remark, close_reason, address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(order_no) DO UPDATE SET status = excluded.status, paid = excluded.paid, postage = excluded.postage,
       payout = excluded.payout, refund = excluded.refund, created_at = excluded.created_at, paid_at = excluded.paid_at,
       shipped_at = excluded.shipped_at, confirmed_at = excluded.confirmed_at, remark = excluded.remark,
       close_reason = excluded.close_reason, address = excluded.address, updated_at = datetime('now', 'localtime')`,
  );
  for (const r of rows) {
    if (!r['订单编号']) continue;
    st.run(
      r['订单编号'],
      r['订单状态'] ?? '',
      fen(r['买家实付金额']),
      fen(r['买家应付邮费']),
      fen(r['确认收货打款金额']),
      fen(r['退款金额']),
      time(r['订单创建时间']),
      time(r['订单付款时间']),
      time(r['发货时间']),
      time(r['确认收货时间']),
      r['商家备注'] ?? '',
      r['订单关闭原因'] === '订单未关闭' ? '' : (r['订单关闭原因'] ?? ''),
      r['收货地址'] ?? '',
    );
  }
}

function upsertSubs(db: DB, rows: Record<string, string>[]) {
  const st = db.prepare(
    `INSERT INTO taobao_sub_orders (sub_no, order_no, item_id, sku, title, price, qty, paid, status, refund_status, refund, shipped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sub_no) DO UPDATE SET status = excluded.status, paid = excluded.paid, refund_status = excluded.refund_status,
       refund = excluded.refund, shipped_at = excluded.shipped_at, title = excluded.title`,
  );
  for (const r of rows) {
    if (!r['子订单编号']) continue;
    st.run(
      r['子订单编号'],
      r['主订单编号'],
      r['商品ID'] ?? '',
      r['商品属性'] ?? '',
      r['商品标题'] ?? '',
      fen(r['商品价格']),
      Number(r['购买数量']) || 1,
      fen(r['买家实付金额']),
      r['订单状态'] ?? '',
      r['退款状态'] ?? '',
      fen(r['退款金额']),
      time(r['发货时间']),
    );
  }
}

// ---------------------------------------------------------------- SKU 对照

interface ProductRow {
  id: number;
  name: string;
  spec: string;
}

/** 给没对照过的 SKU 自动找一个最像的库存商品（confirmed = 0，待人工确认） */
function autoMapSkus(db: DB): number {
  const skus = db
    .prepare(
      `SELECT s.item_id, s.sku, MAX(s.title) AS title FROM taobao_sub_orders s
       WHERE NOT EXISTS (SELECT 1 FROM taobao_sku_map m WHERE m.item_id = s.item_id AND m.sku = s.sku)
       GROUP BY s.item_id, s.sku`,
    )
    .all() as { item_id: string; sku: string; title: string }[];
  if (!skus.length) return 0;
  const products = db.prepare('SELECT id, name, spec FROM products').all() as unknown as ProductRow[];
  const ins = db.prepare('INSERT INTO taobao_sku_map (item_id, sku, product_id, qty, confirmed) VALUES (?, ?, ?, 1, 0)');
  let n = 0;
  for (const s of skus) {
    const best = guessProduct(products, s.title, skuLabel(s.sku));
    if (best) {
      ins.run(s.item_id, s.sku, best.id);
      n++;
    }
  }
  return n;
}

/**
 * 规格名优先（同一个宝贝下不同规格靠它区分）：明显领先才算；规格名太弱时才看标题。
 * 有两个差不多像的就不猜，留给人工。
 */
export function guessProduct(products: ProductRow[], title: string, sku: string): ProductRow | null {
  if (/套装|组合装|\+/.test(sku)) return null; // 套装要人工指定由哪几个商品组成
  const pick = (score: (p: ProductRow) => number) => {
    const scored = products.map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s);
    return { top: scored[0], second: scored[1] };
  };
  const clear = (r: ReturnType<typeof pick>) => r.top && r.top.s >= 0.5 && (!r.second || r.top.s - r.second.s >= 0.15);
  const bySku = pick((p) => Math.max(nameScore(normalizeName(sku), normalizeName(p.name)), titleScore(sku, p.name)));
  if (bySku.top && bySku.top.s >= 0.5) return clear(bySku) ? bySku.top.p : null;
  const full = `${title} ${sku}`;
  const byTitle = pick((p) => Math.max(titleScore(full, p.name), similarity(normalizeName(full), normalizeName(p.name))));
  return clear(byTitle) ? byTitle.top.p : null;
}

export interface MapItemInput {
  product_id?: number;
  catalog_id?: number;
  qty?: number;
}

function resolveItems(db: DB, userId: number, items: MapItemInput[]): { product_id: number; qty: number }[] {
  const out = new Map<number, number>();
  for (const it of items) {
    const qty = it.qty ?? 1;
    if (!Number.isInteger(qty) || qty <= 0) throw new BizError('件数需为正整数');
    let pid = it.product_id;
    if (!Number.isInteger(pid)) {
      if (!Number.isInteger(it.catalog_id)) throw new BizError('请选择商品');
      pid = productFromCatalog(db, userId, it.catalog_id!);
    } else if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(pid!)) throw new BizError('商品不存在');
    out.set(pid!, (out.get(pid!) ?? 0) + qty);
  }
  return [...out].map(([product_id, qty]) => ({ product_id, qty }));
}

/** 设置（并确认）一个 SKU 对应的库存商品；然后把等它的订单生成出来 */
export function setSkuMap(db: DB, userId: number, itemId: string, sku: string, items: MapItemInput[]) {
  return tx(db, () => {
    const rows = resolveItems(db, userId, items);
    if (!rows.length) throw new BizError('至少选一个商品');
    db.prepare('DELETE FROM taobao_sku_map WHERE item_id = ? AND sku = ?').run(itemId, sku);
    const ins = db.prepare('INSERT INTO taobao_sku_map (item_id, sku, product_id, qty, confirmed) VALUES (?, ?, ?, ?, 1)');
    for (const r of rows) ins.run(itemId, sku, r.product_id, r.qty);
    log(db, userId, 'taobao_sku_map', `${itemId}/${sku}`, rows);
    return processTaobao(db, userId);
  });
}

/** 一键确认所有自动匹配的 SKU */
export function confirmAllSkus(db: DB, userId: number) {
  return tx(db, () => {
    const n = Number(db.prepare('UPDATE taobao_sku_map SET confirmed = 1 WHERE confirmed = 0').run().changes);
    log(db, userId, 'taobao_sku_confirm_all', '', { n });
    return processTaobao(db, userId);
  });
}

/**
 * 有商家备注的订单：填实际发出的商品。
 * as_ordered = 备注和实发无关（比如「退运费」），按下单的商品发；confirm = false 只存草稿
 */
export function setActual(
  db: DB,
  userId: number,
  orderNo: string,
  input: { items?: MapItemInput[]; as_ordered?: boolean; confirm?: boolean },
) {
  return tx(db, () => {
    const o = db.prepare('SELECT actual_state FROM taobao_orders WHERE order_no = ?').get(orderNo) as { actual_state: string } | undefined;
    if (!o) throw new BizError('订单不存在');
    if (o.actual_state === 'confirmed') throw new BizError('这个订单的实发已经确认过，不能再改；有出入请做退货或盘点');
    db.prepare('DELETE FROM taobao_actual WHERE order_no = ?').run(orderNo);
    if (!input.as_ordered) {
      const rows = resolveItems(db, userId, input.items ?? []);
      if (!rows.length) throw new BizError('至少填一个实发商品');
      const ins = db.prepare('INSERT INTO taobao_actual (order_no, product_id, qty) VALUES (?, ?, ?)');
      for (const r of rows) ins.run(orderNo, r.product_id, r.qty);
    }
    const state = input.confirm === false ? 'draft' : 'confirmed';
    db.prepare('UPDATE taobao_orders SET actual_state = ? WHERE order_no = ?').run(state, orderNo);
    log(db, userId, 'taobao_actual', orderNo, input);
    return processTaobao(db, userId);
  });
}

/**
 * 标记 / 取消刷单。刷单：不算销售额，淘宝回款记「刷单回款」冲抵刷单返款；
 * items = 实际发出的商品（空包就不填），只扣这些库存，成本算刷单花费。已生成的销售单按新口径重建。
 */
export function setFake(db: DB, userId: number, orderNo: string, input: { fake?: boolean; items?: MapItemInput[] }) {
  return tx(db, () => {
    const o = db.prepare('SELECT * FROM taobao_orders WHERE order_no = ?').get(orderNo) as any;
    if (!o) throw new BizError('订单不存在');
    const fake = input.fake !== false;
    db.prepare('DELETE FROM taobao_actual WHERE order_no = ?').run(orderNo);
    if (fake) {
      const ins = db.prepare('INSERT INTO taobao_actual (order_no, product_id, qty) VALUES (?, ?, ?)');
      for (const r of resolveItems(db, userId, input.items ?? [])) ins.run(orderNo, r.product_id, r.qty);
      db.prepare("UPDATE taobao_orders SET fake = 1, actual_state = 'confirmed' WHERE order_no = ?").run(orderNo);
    } else {
      // 取消刷单：回到按下单商品算；有备注的要重新核对实发
      db.prepare("UPDATE taobao_orders SET fake = 0, actual_state = CASE WHEN remark != '' THEN '' ELSE actual_state END WHERE order_no = ?").run(orderNo);
    }
    const updated = db.prepare('SELECT * FROM taobao_orders WHERE order_no = ?').get(orderNo) as any;
    const docs = db
      .prepare(
        `SELECT DISTINCT s.sale_doc_id AS id FROM taobao_sub_orders s JOIN docs d ON d.id = s.sale_doc_id
         WHERE s.order_no = ? AND d.status = 'active' ORDER BY s.sale_doc_id`,
      )
      .all(orderNo) as { id: number }[];
    const rebuilt: number[] = [];
    for (const d of docs) {
      const subs = db.prepare('SELECT * FROM taobao_sub_orders WHERE sale_doc_id = ? ORDER BY sub_no').all(d.id) as unknown as SubRow[];
      const postage = (db.prepare("SELECT COALESCE(SUM(amount), 0) v FROM doc_adjustments WHERE doc_id = ? AND name = '邮费'").get(d.id) as {
        v: number;
      }).v;
      rebuilt.push(writeSale(db, userId, updated, subs, postage, d.id));
    }
    log(db, userId, 'taobao_fake', orderNo, { fake, items: input.items ?? [] });
    const r = processTaobao(db, userId);
    return { ...r, rebuilt_sales: [...rebuilt, ...r.rebuilt_sales] };
  });
}

// ---------------------------------------------------------------- 生成单据

export interface ProcessResult {
  created_sales: number[];
  /** 补全商品后重建的销售单（旧单作废） */
  rebuilt_sales: number[];
  received: number;
  refunds: number[];
  errors: string[];
}

interface SubRow {
  sub_no: string;
  order_no: string;
  item_id: string;
  sku: string;
  title: string;
  qty: number;
  paid: number;
  status: string;
  refund_status: string;
  refund: number;
  shipped_at: string | null;
  sale_doc_id: number | null;
  refund_doc_id: number | null;
}

/** 未确定商品的金额在销售单上的前缀：计入销售额，但不扣库存 */
export const UNMATCHED_PREFIX = '未匹配：';
export const UNCHECKED_PREFIX = '待核对实发：';

/** 订单的实发是否还没确定（有商家备注且没确认；刷单标记时已一并确认） */
const actualPending = (o: any) => !o.fake && !!o.remark && o.actual_state !== 'confirmed';

const confirmedMap = (db: DB, s: SubRow) =>
  db
    .prepare('SELECT product_id, qty FROM taobao_sku_map WHERE item_id = ? AND sku = ? AND confirmed = 1 ORDER BY product_id')
    .all(s.item_id, s.sku) as { product_id: number; qty: number }[];

/**
 * 一组子订单 → 销售单明细。能确定的商品进明细（扣库存），
 * 确定不了的（SKU 没对照 / 备注实发没核对）只按金额记成「未匹配 / 待核对实发」，计入销售额、不动库存。
 */
function buildSale(db: DB, o: any, subs: SubRow[]) {
  const items: ItemInput[] = [];
  const unresolved: { name: string; amount: number }[] = [];
  const override = db.prepare('SELECT product_id, qty FROM taobao_actual WHERE order_no = ?').all(o.order_no) as {
    product_id: number;
    qty: number;
  }[];
  if (o.fake) {
    // 刷单：只有实际发出的商品扣库存（成本算刷单花费），钱全部记「刷单回款」
    override.forEach((r) => items.push({ product_id: r.product_id, qty: r.qty, amount: 0 }));
    const total = subs.reduce((t, x) => t + x.paid, 0);
    if (total > 0) unresolved.push({ name: '刷单回款', amount: total });
    return { items, unresolved: [], extra: unresolved };
  }
  if (actualPending(o)) {
    for (const s of subs) unresolved.push({ name: `${UNCHECKED_PREFIX}${skuLabel(s.sku) || s.title} ×${s.qty}`, amount: s.paid });
  } else if (override.length) {
    const total = subs.reduce((t, x) => t + x.paid, 0);
    const amounts = split(total, override.map((r) => weightOf(db, r.product_id) * r.qty));
    override.forEach((r, i) => items.push({ product_id: r.product_id, qty: r.qty, amount: amounts[i] }));
  } else {
    for (const s of subs) {
      const maps = confirmedMap(db, s);
      if (!maps.length) {
        unresolved.push({ name: `${UNMATCHED_PREFIX}${skuLabel(s.sku) || s.title} ×${s.qty}`, amount: s.paid });
        continue;
      }
      const amounts = split(s.paid, maps.map((m) => weightOf(db, m.product_id) * m.qty));
      maps.forEach((m, i) => items.push({ product_id: m.product_id, qty: s.qty * m.qty, amount: amounts[i], source_ref: s.sub_no }));
    }
  }
  return { items, unresolved, extra: [] as { name: string; amount: number }[] };
}

/** 这张（有未匹配项的）销售单现在是否能多确定一些商品 */
function canResolveMore(db: DB, o: any, subs: SubRow[], docId: number): boolean {
  if (o.fake || actualPending(o)) return false;
  const lines = db.prepare('SELECT name FROM doc_adjustments WHERE doc_id = ?').all(docId) as { name: string }[];
  if (lines.some((l) => l.name.startsWith(UNCHECKED_PREFIX))) return true; // 实发刚确认
  const withItems = new Set(
    (db.prepare('SELECT DISTINCT source_ref FROM doc_items WHERE doc_id = ?').all(docId) as { source_ref: string | null }[]).map(
      (r) => r.source_ref,
    ),
  );
  return subs.some((s) => !withItems.has(s.sub_no) && confirmedMap(db, s).length > 0);
}

/** 生成（或重建）一个订单的一张销售单；oldDocId 给了就是重建：沿用日期和到账状态，作废旧单、退款单改挂新单 */
function writeSale(db: DB, userId: number, o: any, subs: SubRow[], postage: number, oldDocId?: number): number {
  const pub = publicAccount(db);
  const { items, unresolved, extra } = buildSale(db, o, subs);
  const old = oldDocId ? (db.prepare('SELECT * FROM docs WHERE id = ?').get(oldDocId) as any) : null;
  const received = old ? old.received === 1 : o.status === TB_SUCCESS;
  const adjustments = [...(postage > 0 ? [{ name: '邮费', amount: postage }] : []), ...unresolved, ...extra].filter((a) => a.amount > 0);
  const docId = createDoc(
    db,
    userId,
    {
      type: 'sale',
      category: o.fake ? FAKE_CATEGORY : '',
      account_id: pub,
      doc_date: old ? old.doc_date : subs.map((s) => s.shipped_at!).sort()[0].slice(0, 10),
      channel: '淘宝',
      note: old ? old.note : `淘宝订单 ${o.order_no}${o.remark ? `｜备注：${o.remark}` : ''}`,
      items,
      adjustments,
    },
    {
      source: 'taobao',
      source_ref: o.order_no,
      received: received ? 1 : 0,
      received_at: old ? old.received_at : received ? o.confirmed_at : null,
      allow_empty: true,
    },
  );
  if (unresolved.length) db.prepare("UPDATE docs SET review = 'unmatched' WHERE id = ?").run(docId);
  const upd = db.prepare('UPDATE taobao_sub_orders SET sale_doc_id = ? WHERE sub_no = ?');
  for (const s of subs) upd.run(docId, s.sub_no);
  if (old) {
    moveReturns(db, old.id, docId);
    voidDoc(db, userId, old.id, '补全商品后重建', true);
  }
  return docId;
}

/** 重建销售单时，把挂在旧单上的退款改挂到新单（按子订单 + 商品找对应明细，找不到就转成不关联商品的退款） */
function moveReturns(db: DB, oldId: number, newId: number) {
  const returns = db.prepare("SELECT id FROM docs WHERE ref_doc_id = ? AND type = 'sale_return' AND status = 'active'").all(oldId) as {
    id: number;
  }[];
  for (const r of returns) {
    db.prepare('UPDATE docs SET ref_doc_id = ? WHERE id = ?').run(newId, r.id);
    const lines = db
      .prepare(
        `SELECT i.id, i.qty, i.amount, o.product_id, o.source_ref FROM doc_items i JOIN doc_items o ON o.id = i.ref_item_id WHERE i.doc_id = ?`,
      )
      .all(r.id) as { id: number; qty: number; amount: number; product_id: number; source_ref: string | null }[];
    for (const l of lines) {
      const target = db
        .prepare('SELECT id FROM doc_items WHERE doc_id = ? AND product_id = ? AND source_ref IS ? ORDER BY id LIMIT 1')
        .get(newId, l.product_id, l.source_ref) as { id: number } | undefined;
      if (target) db.prepare('UPDATE doc_items SET ref_item_id = ? WHERE id = ?').run(target.id, l.id);
      else if (l.qty === 0) {
        db.prepare('DELETE FROM doc_items WHERE id = ?').run(l.id);
        db.prepare('INSERT INTO doc_adjustments (doc_id, name, amount) VALUES (?, ?, ?)').run(r.id, '退款', l.amount);
      }
    }
  }
}

/** 根据已导入的原始数据补齐单据：发货 → 销售，交易成功 → 到账，发货后退款 → 待处理退款 */
export function processTaobao(db: DB, userId: number): ProcessResult {
  const res: ProcessResult = { created_sales: [], rebuilt_sales: [], received: 0, refunds: [], errors: [] };
  const subsOf = (orderNo: string) =>
    db.prepare('SELECT * FROM taobao_sub_orders WHERE order_no = ? ORDER BY sub_no').all(orderNo) as unknown as SubRow[];
  const orderOf = (orderNo: string) => db.prepare('SELECT * FROM taobao_orders WHERE order_no = ?').get(orderNo) as any;

  // 1. 有未匹配项的销售单：SKU 对照 / 实发核对补上后重建
  const partial = db
    .prepare("SELECT id, source_ref FROM docs WHERE type = 'sale' AND source = 'taobao' AND status = 'active' AND review = 'unmatched'")
    .all() as { id: number; source_ref: string }[];
  for (const d of partial) {
    const o = orderOf(d.source_ref);
    const subs = subsOf(d.source_ref).filter((s) => s.sale_doc_id === d.id);
    if (!canResolveMore(db, o, subs, d.id)) continue;
    const postage = (db.prepare("SELECT COALESCE(SUM(amount), 0) v FROM doc_adjustments WHERE doc_id = ? AND name = '邮费'").get(d.id) as {
      v: number;
    }).v;
    try {
      res.rebuilt_sales.push(tx(db, () => writeSale(db, userId, o, subs, postage, d.id)));
    } catch (e: any) {
      res.errors.push(`订单 ${d.source_ref} 重建：${e.message}`);
    }
  }

  // 2. 已发货、还没生成销售单的子订单，按主订单生成
  const pendingOrders = db
    .prepare(
      `SELECT o.* FROM taobao_orders o WHERE EXISTS (
         SELECT 1 FROM taobao_sub_orders s WHERE s.order_no = o.order_no AND s.shipped_at IS NOT NULL AND s.sale_doc_id IS NULL)
       ORDER BY o.shipped_at, o.order_no`,
    )
    .all() as any[];
  for (const o of pendingOrders) {
    const all = subsOf(o.order_no);
    const subs = all.filter((s) => s.shipped_at && !s.sale_doc_id);
    // 邮费（主订单实付与子订单实付的差额）挂在这个订单的第一张销售单上
    const first = !all.some((s) => s.sale_doc_id);
    const goods = all.filter((s) => s.shipped_at || s.refund_status !== REFUND_OK).reduce((t, x) => t + x.paid, 0);
    const postage = first ? (o.paid > 0 ? Math.max(0, o.paid - goods) : o.postage) : 0;
    try {
      res.created_sales.push(tx(db, () => writeSale(db, userId, o, subs, postage)));
    } catch (e: any) {
      res.errors.push(`订单 ${o.order_no}：${e.message}`);
    }
  }

  // 3. 交易成功 → 到账
  res.received = Number(
    db
      .prepare(
        `UPDATE docs SET received = 1, received_at = (SELECT confirmed_at FROM taobao_orders o WHERE o.order_no = docs.source_ref)
         WHERE source = 'taobao' AND type = 'sale' AND received = 0 AND status = 'active'
           AND source_ref IN (SELECT order_no FROM taobao_orders WHERE status = ?)`,
      )
      .run(TB_SUCCESS).changes,
  );

  // 4. 发货后退款成功 → 待处理退款（默认仅退款，货未退回）
  const refunds = db
    .prepare(
      `SELECT * FROM taobao_sub_orders WHERE refund_status = ? AND refund > 0 AND sale_doc_id IS NOT NULL AND refund_doc_id IS NULL
       ORDER BY sub_no`,
    )
    .all(REFUND_OK) as unknown as SubRow[];
  for (const s of refunds) {
    const own = db
      .prepare('SELECT id, amount FROM doc_items WHERE doc_id = ? AND source_ref = ? ORDER BY id')
      .all(s.sale_doc_id, s.sub_no) as { id: number; amount: number }[];
    const o = orderOf(s.order_no);
    // 子订单自己的明细 → 按实发填的（明细不分子订单）→ 都没有就是未匹配的，只退钱
    const lines = own.length
      ? own
      : !actualPending(o) && db.prepare('SELECT 1 FROM taobao_actual WHERE order_no = ?').get(s.order_no)
        ? (db.prepare('SELECT id, amount FROM doc_items WHERE doc_id = ? ORDER BY id').all(s.sale_doc_id) as any[])
        : [];
    const amounts = split(s.refund, lines.map((l: { amount: number }) => l.amount || 1));
    try {
      const docId = createReturn(
        db,
        userId,
        s.sale_doc_id!,
        {
          items: lines.map((l: { id: number }, i: number) => ({ ref_item_id: l.id, qty: 0, amount: amounts[i] })),
          extra: lines.length ? [] : [{ name: `退款：${skuLabel(s.sku) || s.title}`, amount: s.refund }],
          doc_date: today(),
          note: `淘宝退款 子订单 ${s.sub_no}，待确认货是否退回`,
        },
        { review: 'pending' },
      );
      db.prepare('UPDATE taobao_sub_orders SET refund_doc_id = ? WHERE sub_no = ?').run(docId, s.sub_no);
      res.refunds.push(docId);
    } catch (e: any) {
      res.errors.push(`子订单 ${s.sub_no} 退款：${e.message}`);
    }
  }
  return res;
}

// ---------------------------------------------------------------- 导入入口

export interface ImportReport extends ProcessResult {
  orders: number;
  sub_orders: number;
  auto_mapped: number;
  unmatched_orders: number;
  unmatched_amount: number;
  to_ship: number;
  negative: { id: number; name: string; stock_qty: number }[];
}

export function importTaobao(db: DB, userId: number, orderRows: Record<string, string>[], itemRows: Record<string, string>[]): ImportReport {
  if (!orderRows.length || detectSheet(orderRows) !== 'orders') throw new BizError('缺少主订单表（含「订单编号」「买家应付邮费」列）');
  if (!itemRows.length || detectSheet(itemRows) !== 'items') throw new BizError('缺少子订单表（含「子订单编号」「主订单编号」列）');
  return tx(db, () => {
    upsertOrders(db, orderRows);
    upsertSubs(db, itemRows);
    const autoMapped = autoMapSkus(db);
    const r = processTaobao(db, userId);
    const s = taobaoStatus(db);
    log(db, userId, 'taobao_import', '', {
      orders: orderRows.length,
      subs: itemRows.length,
      sales: r.created_sales.length,
      rebuilt: r.rebuilt_sales.length,
      received: r.received,
      refunds: r.refunds.length,
      errors: r.errors,
    });
    return {
      ...r,
      orders: orderRows.length,
      sub_orders: itemRows.length,
      auto_mapped: autoMapped,
      unmatched_orders: s.unmatched_orders,
      unmatched_amount: s.unmatched_amount,
      to_ship: s.to_ship,
      negative: db.prepare('SELECT id, name, stock_qty FROM products WHERE stock_qty < 0 ORDER BY stock_qty').all() as any[],
    };
  });
}

// ---------------------------------------------------------------- 查询

/** 待办计数（首页 / 导入结果用） */
export function taobaoStatus(db: DB) {
  const one = (sql: string, ...p: string[]) => (db.prepare(sql).get(...p) as { n: number }).n;
  return {
    /** 有商品没确定（没扣库存）的淘宝销售单数，以及这部分金额 */
    unmatched_orders: one("SELECT COUNT(*) n FROM docs WHERE type = 'sale' AND source = 'taobao' AND status = 'active' AND review = 'unmatched'"),
    unmatched_amount: one(
      `SELECT COALESCE(SUM(j.amount), 0) n FROM doc_adjustments j JOIN docs d ON d.id = j.doc_id
       WHERE d.type = 'sale' AND d.source = 'taobao' AND d.status = 'active' AND (j.name LIKE ? OR j.name LIKE ?)`,
      `${UNMATCHED_PREFIX}%`,
      `${UNCHECKED_PREFIX}%`,
    ),
    unchecked_orders: one(
      `SELECT COUNT(*) n FROM taobao_orders o WHERE remark != '' AND actual_state != 'confirmed' AND fake = 0
       AND EXISTS (SELECT 1 FROM taobao_sub_orders s WHERE s.order_no = o.order_no AND s.shipped_at IS NOT NULL)`,
    ),
    to_ship: one('SELECT COUNT(*) n FROM taobao_orders WHERE status = ?', TB_TO_SHIP),
    fake_orders: one('SELECT COUNT(*) n FROM taobao_orders WHERE fake = 1'),
    unconfirmed_sku: one('SELECT COUNT(DISTINCT item_id || sku) n FROM taobao_sku_map WHERE confirmed = 0'),
    pending_refunds: one("SELECT COUNT(*) n FROM docs WHERE type = 'sale_return' AND review = 'pending' AND status = 'active'"),
    last_import: (db.prepare("SELECT MAX(created_at) v FROM logs WHERE action = 'taobao_import'").get() as { v: string | null }).v,
  };
}

const productNames = (db: DB, rows: { product_id: number; qty: number }[]) =>
  rows.map((r) => {
    const p = db.prepare('SELECT name, spec, stock_qty FROM products WHERE id = ?').get(r.product_id) as any;
    return { ...r, name: p?.name ?? '?', spec: p?.spec ?? '', stock_qty: p?.stock_qty ?? 0 };
  });

/** SKU 对照表：每个淘宝 SKU、卖了多少、对应到哪些商品 */
export function listSkus(db: DB) {
  const skus = db
    .prepare(
      `SELECT item_id, sku, MAX(title) AS title, COUNT(*) AS lines, SUM(qty) AS qty,
              SUM(CASE WHEN shipped_at IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM taobao_sku_map m WHERE m.item_id = s.item_id AND m.sku = s.sku AND m.confirmed = 1) THEN 1 ELSE 0 END) AS waiting
       FROM taobao_sub_orders s GROUP BY item_id, sku ORDER BY waiting DESC, lines DESC`,
    )
    .all() as any[];
  return skus.map((s) => {
    const maps = db.prepare('SELECT product_id, qty, confirmed FROM taobao_sku_map WHERE item_id = ? AND sku = ? ORDER BY product_id').all(
      s.item_id,
      s.sku,
    ) as any[];
    return {
      ...s,
      label: skuLabel(s.sku),
      state: !maps.length ? 'none' : maps.every((m) => m.confirmed) ? 'confirmed' : 'auto',
      products: productNames(db, maps),
    };
  });
}

/** 有商家备注、实发还没确认的已发货订单 */
export function listActual(db: DB) {
  const orders = db
    .prepare(
      `SELECT o.* FROM taobao_orders o WHERE o.remark != '' AND o.actual_state != 'confirmed' AND o.fake = 0 AND EXISTS (
         SELECT 1 FROM taobao_sub_orders s WHERE s.order_no = o.order_no AND s.shipped_at IS NOT NULL)
       ORDER BY o.shipped_at`,
    )
    .all() as any[];
  return orders.map((o) => ({
    ...o,
    subs: (db.prepare('SELECT sub_no, sku, title, qty, paid, status FROM taobao_sub_orders WHERE order_no = ?').all(o.order_no) as any[]).map(
      (s) => ({ ...s, label: skuLabel(s.sku) }),
    ),
    actual: productNames(db, db.prepare('SELECT product_id, qty FROM taobao_actual WHERE order_no = ?').all(o.order_no) as any[]),
  }));
}

/** 有商品没确定、没扣库存的淘宝销售单（营业额提示点进来看的） */
export function listUnmatched(db: DB) {
  const docs = db
    .prepare(
      `SELECT d.id, d.doc_date, d.source_ref, d.amount, o.remark FROM docs d LEFT JOIN taobao_orders o ON o.order_no = d.source_ref
       WHERE d.type = 'sale' AND d.source = 'taobao' AND d.status = 'active' AND d.review = 'unmatched' ORDER BY d.doc_date, d.id`,
    )
    .all() as any[];
  const lines = db.prepare('SELECT name, amount FROM doc_adjustments WHERE doc_id = ? AND (name LIKE ? OR name LIKE ?) ORDER BY id');
  return docs.map((d) => ({ ...d, lines: lines.all(d.id, `${UNMATCHED_PREFIX}%`, `${UNCHECKED_PREFIX}%`) }));
}

/** 买家已付款、还没发货的订单 */
export function listToShip(db: DB) {
  const orders = db.prepare('SELECT * FROM taobao_orders WHERE status = ? ORDER BY paid_at').all(TB_TO_SHIP) as any[];
  return orders.map((o) => ({
    ...o,
    subs: (db.prepare('SELECT sub_no, item_id, sku, title, qty, paid FROM taobao_sub_orders WHERE order_no = ?').all(o.order_no) as any[]).map(
      (s) => ({
        ...s,
        label: skuLabel(s.sku),
        products: productNames(
          db,
          db.prepare('SELECT product_id, qty FROM taobao_sku_map WHERE item_id = ? AND sku = ?').all(s.item_id, s.sku) as any[],
        ),
      }),
    ),
  }));
}

/** 待确认的退款（导入自动生成的仅退款） */
export function listPendingRefunds(db: DB) {
  return db
    .prepare(
      `SELECT r.id, r.doc_date, r.amount, r.ref_doc_id, r.source_ref, r.note,
              (SELECT GROUP_CONCAT(p.name, '、') FROM doc_items i JOIN products p ON p.id = i.product_id WHERE i.doc_id = r.id) AS item_summary
       FROM docs r WHERE r.type = 'sale_return' AND r.review = 'pending' AND r.status = 'active' ORDER BY r.id`,
    )
    .all();
}

/** 确认待处理退款确实只退了钱、货没回来 */
export function confirmRefundOnly(db: DB, userId: number, docId: number) {
  const r = db.prepare("SELECT review FROM docs WHERE id = ? AND type = 'sale_return' AND status = 'active'").get(docId) as any;
  if (!r) throw new BizError('退款单不存在');
  db.prepare("UPDATE docs SET review = '' WHERE id = ?").run(docId);
  log(db, userId, 'confirm_refund_only', `doc:${docId}`);
}

