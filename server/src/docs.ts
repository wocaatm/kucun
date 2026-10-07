import type { DB } from './db.ts';
import { tx, log } from './db.ts';
import { IN_TYPES, replayProduct, landedCosts } from './inventory.ts';
import { productFromCatalog } from './catalog.ts';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, OUTBOUND_CATEGORIES } from './settings.ts';

export const DOC_TYPES = [
  'purchase', // 进货：付款账户 -金额，商品入库
  'sale', // 销售：收款账户 +金额，商品出库
  'sale_return', // 退货 / 退款：关联原销售单，按行填退回件数、退款、退回成本；件数为 0 是仅退款
  'outbound', // 其他出库：自用 / 送人 / 损耗
  'stocktake', // 盘点：明细 qty 为带符号差异
  'opening_stock', // 期初库存：入库但不动钱
  'expense', // 支出
  'income', // 收入：追加投资 / 其他收入
  'transfer', // 账户间转账（报销 / 上交代收款）
  'opening_balance', // 期初余额（带符号）
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export interface ItemInput {
  product_id?: number;
  /** 参考库商品：提交时自动建档（已建过则复用） */
  catalog_id?: number;
  /** 从参考库建档时顺便绑定的条码 */
  barcode?: string;
  qty?: number;
  unit_price?: number;
  /** 入库类：这一行的总价（分，含运费等分摊）。给了就按总价记成本，unit_price 由它算出均价 */
  amount?: number;
  counted_qty?: number;
  /** 进货：其中真正入库的件数（0 ~ qty，默认 = qty）。没入库的不进库存，钱照样算在付款账户上；qty 是买入数，均价按它算 */
  in_qty?: number;
  raw_name?: string;
  /** 仅导入用：淘宝子订单号 */
  source_ref?: string;
}

export interface DocInput {
  type: DocType;
  category?: string;
  doc_date?: string;
  account_id?: number | null;
  to_account_id?: number | null;
  amount?: number;
  channel?: string;
  counterparty?: string;
  note?: string;
  items?: ItemInput[];
  upload_ids?: number[];
  /** 进货：额外费用 / 减免，可多项。计入实付，不摊进商品成本。销售：只能是正数（如邮费），计入销售额 */
  adjustments?: AdjustmentInput[];
}

/** 系统内部字段（导入用），不接受页面直接传 */
export interface DocSys {
  source?: string;
  source_ref?: string;
  received?: number | null;
  received_at?: string | null;
  /** 导入的销售单可以没有商品明细（商品都没匹配上，只记金额） */
  allow_empty?: boolean;
}

/** amount 带符号（分）：正数是额外费用（运费、包装费…），负数是减免（优惠券、满减…） */
export interface AdjustmentInput {
  name?: string;
  amount?: number;
}

export class BizError extends Error {
  status = 400;
}

const fail = (msg: string): never => {
  throw new BizError(msg);
};

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function requireAccount(db: DB, id: unknown, label = '账户') {
  if (!isInt(id) || !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) fail(`请选择${label}`);
}

export function createDoc(db: DB, userId: number, input: DocInput, sys: DocSys = {}): number {
  const type = input.type;
  if (!DOC_TYPES.includes(type)) fail('未知单据类型');
  const items = input.items ?? [];
  const docDate = input.doc_date && /^\d{4}-\d{2}-\d{2}$/.test(input.doc_date) ? input.doc_date : today();

  for (const it of items) {
    const ok = isInt(it.product_id)
      ? db.prepare('SELECT 1 FROM products WHERE id = ?').get(it.product_id)
      : isInt(it.catalog_id) && db.prepare('SELECT 1 FROM catalog_items WHERE id = ?').get(it.catalog_id);
    if (!ok) fail('明细里有不存在的商品');
  }

  let amount = 0;
  const adjustments: { name: string; amount: number }[] = [];
  let category = input.category ?? '';
  switch (type) {
    case 'purchase':
    case 'opening_stock':
    case 'sale':
    case 'outbound': {
      if (!items.length && !(type === 'sale' && sys.allow_empty)) fail('至少添加一个商品');
      for (const it of items) {
        if (!isInt(it.qty) || it.qty <= 0) fail('数量需为正整数');
        if (it.in_qty != null && (type !== 'purchase' || !isInt(it.in_qty) || it.in_qty < 0 || it.in_qty > it.qty!)) fail('入库数需在 0 到买入数之间');
        if ((IN_TYPES.has(type) || type === 'sale') && it.amount != null) {
          if (!isInt(it.amount) || it.amount < 0) fail('总价不能为空');
          it.unit_price = Math.round(it.amount / it.qty!);
        } else {
          if (type !== 'outbound' && (!isInt(it.unit_price) || it.unit_price < 0)) fail('单价不能为空');
          it.amount = type === 'outbound' ? 0 : it.qty! * it.unit_price!;
        }
      }
      amount = items.reduce((s, it) => s + it.amount!, 0);
      if (type === 'purchase' || type === 'sale') {
        for (const a of input.adjustments ?? []) {
          const name = a.name?.trim() ?? '';
          if (!name) fail('费用 / 减免项需要填名称');
          if (!isInt(a.amount) || a.amount === 0) fail(`「${name}」金额不能为空`);
          if (type === 'sale' && a.amount! < 0) fail('销售单只能加收费用（如邮费）');
          adjustments.push({ name, amount: a.amount! });
          amount += a.amount!;
        }
        if (amount < 0) fail('减免不能超过应付金额');
      }
      if (type === 'purchase' || type === 'sale') requireAccount(db, input.account_id, type === 'sale' ? '收款账户' : '付款账户');
      if (type === 'outbound' && !OUTBOUND_CATEGORIES.includes(category)) fail('请选择出库类型');
      break;
    }
    case 'sale_return':
      fail('退货请从原销售单发起');
      break;
    case 'stocktake':
      if (!items.length) fail('至少盘点一个商品');
      for (const it of items) if (!isInt(it.counted_qty) || it.counted_qty < 0) fail('实盘数量需为非负整数');
      break;
    case 'expense':
    case 'income':
      if (!isInt(input.amount) || input.amount <= 0) fail('金额需大于 0');
      amount = input.amount!;
      requireAccount(db, input.account_id);
      if (!(type === 'expense' ? EXPENSE_CATEGORIES : INCOME_CATEGORIES).includes(category)) fail('请选择分类');
      break;
    case 'transfer':
      if (!isInt(input.amount) || input.amount <= 0) fail('金额需大于 0');
      amount = input.amount!;
      requireAccount(db, input.account_id, '转出账户');
      requireAccount(db, input.to_account_id, '转入账户');
      if (input.account_id === input.to_account_id) fail('转出和转入不能是同一个账户');
      break;
    case 'opening_balance':
      if (!isInt(input.amount) || input.amount === 0) fail('金额不能为 0');
      amount = input.amount!;
      requireAccount(db, input.account_id);
      break;
  }

  return tx(db, () => {
    const r = db
      .prepare(
        `INSERT INTO docs (type, category, doc_date, account_id, to_account_id, amount, channel, counterparty, note, created_by,
                           source, source_ref, received, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        type,
        category,
        docDate,
        input.account_id ?? null,
        type === 'transfer' ? input.to_account_id! : null,
        amount,
        input.channel ?? '',
        input.counterparty ?? '',
        input.note ?? '',
        userId,
        sys.source ?? null,
        sys.source_ref ?? null,
        sys.received ?? null,
        sys.received_at ?? null,
      );
    const docId = Number(r.lastInsertRowid);

    const ins = db.prepare(
      'INSERT INTO doc_items (doc_id, product_id, qty, unit_price, amount, counted_qty, raw_name, source_ref, in_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    // 进货：优惠和运费按标价比例摊进每行，库存成本按实付算
    const landed =
      type === 'purchase' ? landedCosts(items.map((it) => it.amount ?? 0), adjustments.reduce((t, a) => t + a.amount, 0)) : [];
    const touched = new Set<number>();
    for (const [idx, it] of items.entries()) {
      if (!isInt(it.product_id)) it.product_id = productFromCatalog(db, userId, it.catalog_id!, it.barcode);
      if (type === 'stocktake') {
        // 差异按录入这一刻的系统库存计算，之后固定不变
        const p = db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(it.product_id) as { stock_qty: number };
        ins.run(docId, it.product_id, it.counted_qty! - p.stock_qty, 0, 0, it.counted_qty!, '', null, null);
      } else {
        // 进货入库数比买入数少：库存只进入库的件数和对应的成本，其余只记花的钱
        const inQty = it.in_qty ?? it.qty!;
        const r = ins.run(
          docId,
          it.product_id,
          inQty,
          it.unit_price ?? 0,
          it.amount ?? 0,
          null,
          it.raw_name ?? '',
          sys.source ? (it.source_ref ?? null) : null,
          type === 'purchase' ? Math.round((landed[idx] * inQty) / it.qty!) : null,
        );
        if (inQty !== it.qty) db.prepare('UPDATE doc_items SET buy_qty = ? WHERE id = ?').run(it.qty!, r.lastInsertRowid);
      }
      touched.add(it.product_id);
      // 记住「小票上的名字 → 商品」，下次识别自动匹配
      if (it.raw_name?.trim()) {
        db.prepare('INSERT OR REPLACE INTO product_aliases (alias, product_id) VALUES (?, ?)').run(
          normalizeName(it.raw_name),
          it.product_id,
        );
      }
    }
    for (const pid of touched) replayProduct(db, pid);

    const insAdj = db.prepare('INSERT INTO doc_adjustments (doc_id, name, amount) VALUES (?, ?, ?)');
    for (const a of adjustments) insAdj.run(docId, a.name, a.amount);

    for (const uid of input.upload_ids ?? []) {
      db.prepare('UPDATE uploads SET doc_id = ? WHERE id = ? AND doc_id IS NULL').run(docId, uid);
    }
    log(db, userId, 'create_doc', `doc:${docId}`, { type, amount, items: items.length, adjustments: adjustments.length });
    return docId;
  });
}

/** system = true 是导入 / 退货替换内部调用，允许作废淘宝导入的单据 */
export function voidDoc(db: DB, userId: number, docId: number, reason: string, system = false) {
  const doc = db.prepare('SELECT status, source FROM docs WHERE id = ?').get(docId) as { status: string; source: string | null } | undefined;
  if (!doc) fail('单据不存在');
  if (doc!.status === 'void') fail('单据已作废');
  if (!reason?.trim()) fail('请填写作废原因');
  if (doc!.source === 'taobao' && !system) fail('淘宝导入的单据由导入维护，不能手动作废；退货请用「退货/退款」');
  if (!system && db.prepare("SELECT 1 FROM docs WHERE ref_doc_id = ? AND type = 'sale_return' AND status = 'active'").get(docId)) {
    fail('这张销售单有退货记录，请先作废退货单');
  }
  tx(db, () => {
    db.prepare(
      `UPDATE docs SET status = 'void', voided_by = ?, voided_at = datetime('now', 'localtime'), void_reason = ? WHERE id = ?`,
    ).run(userId, reason.trim(), docId);
    const pids = db.prepare('SELECT DISTINCT product_id FROM doc_items WHERE doc_id = ?').all(docId) as { product_id: number }[];
    for (const { product_id } of pids) replayProduct(db, product_id);
    log(db, userId, 'void_doc', `doc:${docId}`, { reason });
  });
}

export function getDoc(db: DB, docId: number) {
  const doc = db
    .prepare(
      `SELECT d.*, u.name AS created_by_name, v.name AS voided_by_name,
              a.name AS account_name, t.name AS to_account_name
       FROM docs d
       JOIN users u ON u.id = d.created_by
       LEFT JOIN users v ON v.id = d.voided_by
       LEFT JOIN accounts a ON a.id = d.account_id
       LEFT JOIN accounts t ON t.id = d.to_account_id
       WHERE d.id = ?`,
    )
    .get(docId);
  if (!doc) return null;
  const items = db
    .prepare(
      `SELECT i.*, p.name AS product_name, p.spec, p.barcode
       FROM doc_items i JOIN products p ON p.id = i.product_id WHERE i.doc_id = ? ORDER BY i.id`,
    )
    .all(docId);
  const uploads = db.prepare('SELECT * FROM uploads WHERE doc_id = ? ORDER BY id').all(docId);
  const adjustments = db.prepare('SELECT id, name, amount FROM doc_adjustments WHERE doc_id = ? ORDER BY id').all(docId);
  const d = doc as { type: string; ref_doc_id: number | null; source: string | null; source_ref: string | null };
  const extra: Record<string, unknown> = {};
  if (d.type === 'sale') {
    const used = returnedByItem(db, docId);
    for (const it of items as any[]) {
      const u = used.get(it.id);
      it.returned_qty = u?.qty ?? 0;
      it.refunded = u?.amount ?? 0;
      it.unit_cost = saleItemUnitCost(db, it);
    }
    extra.returns = db
      .prepare(`SELECT id, doc_date, amount, status, review FROM docs WHERE ref_doc_id = ? AND type = 'sale_return' ORDER BY id`)
      .all(docId);
  }
  if (d.type === 'sale_return' && d.ref_doc_id) {
    extra.ref_doc = db.prepare('SELECT id, doc_date, amount, status, source_ref FROM docs WHERE id = ?').get(d.ref_doc_id);
  }
  if (d.source === 'taobao' && d.source_ref) {
    extra.taobao_order = db.prepare('SELECT * FROM taobao_orders WHERE order_no = ?').get(d.source_ref) ?? null;
  }
  return { ...doc, items, uploads, adjustments, ...extra };
}

/** 一张销售单每行已退回的件数、已退款金额（只算有效退货单，可排除某张） */
function returnedByItem(db: DB, saleId: number, excludeDocId = 0) {
  const rows = db
    .prepare(
      `SELECT i.ref_item_id AS id, SUM(i.qty) AS qty, SUM(i.amount) AS amount FROM doc_items i JOIN docs r ON r.id = i.doc_id
       WHERE r.ref_doc_id = ? AND r.type = 'sale_return' AND r.status = 'active' AND r.id != ? GROUP BY i.ref_item_id`,
    )
    .all(saleId, excludeDocId) as { id: number; qty: number; amount: number }[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** 销售明细的单件卖出成本；成本待定时用商品当前均价 */
function saleItemUnitCost(db: DB, it: { qty: number; cost_amount: number; cost_pending: number; product_id: number }): number {
  const known = it.qty - it.cost_pending;
  if (known > 0) return Math.round(it.cost_amount / known);
  const p = db.prepare('SELECT stock_qty, stock_value, last_cost FROM products WHERE id = ?').get(it.product_id) as any;
  return (p.stock_qty > 0 ? Math.round(p.stock_value / p.stock_qty) : p.last_cost) ?? 0;
}

export interface ReturnItemInput {
  ref_item_id?: number;
  /** 退回的件数；0 = 仅退款，货没回来 */
  qty?: number;
  /** 这一行退给买家的钱（分） */
  amount?: number;
  /** 退回入库的成本（分）；不填按原卖出成本 × 件数 */
  in_cost?: number;
}

export interface ReturnInput {
  items?: ReturnItemInput[];
  /** 不关联商品的退款（如邮费、未匹配商品的退款） */
  extra?: { name?: string; amount?: number }[];
  doc_date?: string;
  note?: string;
}

export interface ReturnOpts {
  /** pending = 导入自动生成、待确认货有没有退回 */
  review?: string;
  /** 用这张退货单替换掉的旧退货单（确认待处理退款时） */
  replaceDocId?: number;
  source_ref?: string | null;
}

/** 退货 / 退款：从原销售单发起，按行退件数和金额，退回的钱从原收款账户出 */
export function createReturn(db: DB, userId: number, saleId: number, input: ReturnInput, opts: ReturnOpts = {}): number {
  const sale = db.prepare("SELECT * FROM docs WHERE id = ? AND type = 'sale'").get(saleId) as any;
  if (!sale) fail('原销售单不存在');
  if (sale.status !== 'active') fail('原销售单已作废');
  const replace = opts.replaceDocId
    ? (db.prepare("SELECT id, status FROM docs WHERE id = ? AND type = 'sale_return' AND ref_doc_id = ?").get(opts.replaceDocId, saleId) as any)
    : null;
  if (opts.replaceDocId && (!replace || replace.status !== 'active')) fail('要替换的退货单不存在或已作废');

  const saleItems = new Map(
    (db.prepare('SELECT * FROM doc_items WHERE doc_id = ?').all(saleId) as any[]).map((it) => [it.id, it]),
  );
  const used = returnedByItem(db, saleId, opts.replaceDocId ?? 0);
  const rows: { it: any; qty: number; amount: number; in_cost: number }[] = [];
  for (const r of input.items ?? []) {
    const it = saleItems.get(r.ref_item_id!);
    if (!it) fail('退货明细不属于这张销售单');
    const qty = r.qty ?? 0;
    const amount = r.amount ?? 0;
    if (!isInt(qty) || qty < 0) fail('退回件数需为非负整数');
    if (!isInt(amount) || amount < 0) fail('退款金额不能为负');
    if (qty === 0 && amount === 0) continue;
    if (qty + (used.get(it.id)?.qty ?? 0) > it.qty) fail('退回件数超过了卖出的数量');
    let inCost = 0;
    if (qty > 0) {
      inCost = r.in_cost ?? saleItemUnitCost(db, it) * qty;
      if (!isInt(inCost) || inCost < 0) fail('退回成本不能为负');
    }
    rows.push({ it, qty, amount, in_cost: inCost });
  }
  const extra: { name: string; amount: number }[] = [];
  for (const e of input.extra ?? []) {
    if (!isInt(e.amount) || e.amount! <= 0) fail('退款金额需大于 0');
    extra.push({ name: e.name?.trim() || '退款', amount: e.amount! });
  }
  if (!rows.length && !extra.length) fail('请至少填一行退回件数或退款金额');
  const amount = rows.reduce((s, r) => s + r.amount, 0) + extra.reduce((s, e) => s + e.amount, 0);
  const refundedBefore = (
    db
      .prepare("SELECT COALESCE(SUM(amount), 0) v FROM docs WHERE ref_doc_id = ? AND type = 'sale_return' AND status = 'active' AND id != ?")
      .get(saleId, opts.replaceDocId ?? 0) as { v: number }
  ).v;
  if (refundedBefore + amount > sale.amount) fail('累计退款超过了这张销售单的金额');
  const docDate = input.doc_date && /^\d{4}-\d{2}-\d{2}$/.test(input.doc_date) ? input.doc_date : today();

  return tx(db, () => {
    if (replace) voidDoc(db, userId, replace.id, '确认退货后替换', true);
    const r = db
      .prepare(
        `INSERT INTO docs (type, doc_date, account_id, amount, channel, counterparty, note, created_by, source, source_ref, ref_doc_id, review)
         VALUES ('sale_return', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        docDate,
        sale.account_id,
        amount,
        sale.channel,
        sale.counterparty,
        input.note ?? '',
        userId,
        sale.source,
        opts.source_ref ?? sale.source_ref,
        saleId,
        opts.review ?? '',
      );
    const docId = Number(r.lastInsertRowid);
    const ins = db.prepare(
      'INSERT INTO doc_items (doc_id, product_id, qty, unit_price, amount, in_cost, ref_item_id, source_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const touched = new Set<number>();
    for (const x of rows) {
      ins.run(docId, x.it.product_id, x.qty, x.qty ? Math.round(x.amount / x.qty) : x.amount, x.amount, x.in_cost, x.it.id, x.it.source_ref);
      touched.add(x.it.product_id);
    }
    for (const pid of touched) replayProduct(db, pid);
    const insAdj = db.prepare('INSERT INTO doc_adjustments (doc_id, name, amount) VALUES (?, ?, ?)');
    for (const e of extra) insAdj.run(docId, e.name, e.amount);
    if (replace) db.prepare('UPDATE taobao_sub_orders SET refund_doc_id = ? WHERE refund_doc_id = ?').run(docId, replace.id);
    log(db, userId, 'create_return', `doc:${docId}`, { sale: saleId, amount, replace: replace?.id ?? null, review: opts.review ?? '' });
    return docId;
  });
}
