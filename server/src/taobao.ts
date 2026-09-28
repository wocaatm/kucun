import type { DB } from './db.ts';
import { tx, log } from './db.ts';
import { createDoc, createReturn, voidDoc, BizError, normalizeName, today, type ItemInput } from './docs.ts';
import { productFromCatalog } from './catalog.ts';
import { allocate } from './inventory.ts';
import { nameScore, titleScore } from './vision.ts';

/**
 * 淘宝订单导入（千牛导出的「订单列表」主订单表 + 子订单表）。
 *
 * - 子订单有发货时间 → 生成销售单（按主订单，一次发货一张），扣库存，钱记在公共资金但标「未到账」= 淘宝应收
 * - 主订单变成交易成功 → 销售单标「已到账」
 * - 发货后退款成功 → 自动生成「待处理退款」（仅退款），等人工确认货有没有退回
 * - 没发货就关闭 / 退款的子订单不生成任何单据
 * - 主订单有商家备注 → 先等人工核对实际发了什么（taobao_actual）再扣库存
 * - 任何订单都能随时改实发（刷单空包、改发别的），已生成的销售单按新实发重建
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

/** 卖过的和商品清单里的全部 SKU（去重），带标题 */
const ALL_SKUS = `SELECT item_id, sku, MAX(title) AS title FROM (
    SELECT item_id, sku, title FROM taobao_sub_orders
    UNION ALL SELECT k.item_id, k.sku, COALESCE(i.title, '') FROM taobao_skus k LEFT JOIN taobao_items i ON i.item_id = k.item_id
  ) GROUP BY item_id, sku`;

/** 给没对照过的 SKU 自动找一个最像的库存商品（confirmed = 0，待人工确认） */
function autoMapSkus(db: DB): number {
  const skus = db
    .prepare(
      `SELECT a.* FROM (${ALL_SKUS}) a
       WHERE NOT EXISTS (SELECT 1 FROM taobao_sku_map m WHERE m.item_id = a.item_id AND m.sku = a.sku)`,
    )
    .all() as { item_id: string; sku: string; title: string }[];
  const ins = db.prepare('INSERT INTO taobao_sku_map (item_id, sku, product_id, qty, confirmed) VALUES (?, ?, ?, 1, 0)');
  let n = 0;
  for (const s of skus) {
    const best = guessProduct(db, s.title, s.sku);
    if (best) {
      ins.run(s.item_id, s.sku, best);
      n++;
    }
  }
  return n;
}

/**
 * 自动预填一个对照（仍要人确认才生效）：最像的库存商品 ≥ 60% 且比第二名领先 15% 以上才填，
 * 套装、差不多像的都不猜，留给人从建议里挑。
 */
export function guessProduct(db: DB, title: string, sku: string): number | null {
  if (/套装|组合装|\+/.test(skuLabel(sku))) return null;
  const [top, second] = suggest(db, title, sku, 2).filter((x) => x.product_id);
  if (!top || top.score < 0.6 || (second && top.score - second.score < 0.15)) return null;
  return top.product_id!;
}

/** 给人挑的候选：库存商品（product_id）或奥乐齐参考库里还没建档的（catalog_id，选了才建档） */
export interface Suggestion {
  product_id?: number;
  catalog_id?: number;
  name: string;
  spec: string;
  stock_qty: number | null;
  score: number;
}

/**
 * 按淘宝标题 / 规格名（或商家备注）给出最像的几个商品，由人挑，系统不替人定。
 * 多规格商品的标题列着所有规格，区分不了，所以规格名为主、标题为辅；规格里的数字（280mm、6片）对上加分、同单位对不上扣分。
 * 库存商品都不太像时，再从奥乐齐参考库里找没建档的。
 */
export function suggest(db: DB, title: string, sku: string, limit = 4): Suggestion[] {
  const label = skuLabel(sku);
  const want = sizes(label || title);
  const score = (name: string) => {
    let s = label ? 0.6 * textScore(label, name) + 0.4 * textScore(title, name) : textScore(title, name);
    const have = sizes(name);
    if (want.length && have.length) {
      if (want.some((w) => have.includes(w))) s += 0.15;
      else if (want.some((w) => have.some((h) => unit(h) === unit(w)))) s -= 0.3;
    }
    return Math.max(0, Math.min(1, s));
  };
  const products = (db.prepare('SELECT id, name, spec, stock_qty FROM products').all() as any[])
    .map((p) => ({ product_id: p.id, name: p.name, spec: p.spec, stock_qty: p.stock_qty, score: score(`${p.name} ${p.spec}`) }))
    .filter((x) => x.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (products[0]?.score >= 0.75) return products.map(round);
  const catalog = (
    db
      .prepare(
        `SELECT c.id, c.name, c.spec FROM catalog_items c
         WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.source = c.source AND p.source_id = c.source_id)`,
      )
      .all() as any[]
  )
    .map((c) => ({ catalog_id: c.id, name: c.name, spec: c.spec, stock_qty: null, score: score(`${c.name} ${c.spec}`) }))
    .filter((x) => x.score >= 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  return [...products, ...catalog].sort((a, b) => b.score - a.score).map(round);
}

const cjk = (s: string) => s.replace(/[^\u4e00-\u9fff]/g, '');

/** 两段文字的相似度：整体相似 / 长标题包含 / 共同的中文词（「护手霜」这种关键词） */
function textScore(q: string, name: string): number {
  if (!q.trim()) return 0;
  const common = longestCommon(cjk(q), cjk(name));
  return Math.max(nameScore(normalizeName(q), normalizeName(name)), titleScore(q, name), common >= 2 ? Math.min(0.9, 0.4 + common * 0.1) : 0);
}

function longestCommon(a: string, b: string): number {
  let best = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = tmp;
    }
  }
  return best;
}

/** 规格里的数量 / 容量：「280mm」「6片」「300克」→ ['280mm', '6片', '300g'] */
function sizes(s: string): string[] {
  return [...s.matchAll(/(\d+(?:\.\d+)?)\s*(ml|g|克|mm|片|支|只|包|条|袋|瓶|盒|罐|pc)/gi)].map((m) => {
    const u = m[2].toLowerCase();
    return `${Number(m[1])}${u === '克' ? 'g' : u === 'pc' ? '片' : u}`;
  });
}
const unit = (x: string) => x.replace(/^[\d.]+/, '');
const round = (x: Suggestion) => ({ ...x, score: Math.round(x.score * 100) / 100 });

export interface CatalogInput {
  item_id?: string;
  title?: string;
  status?: string;
  skus?: { sku_id?: string; prop?: string; price?: string }[];
}

/**
 * 插件上传的千牛商品清单：记下每个商品的全部 SKU（规格名和子订单「商品属性」同格式），
 * 没对照过的自动猜一个库存商品（待确认）；已有对照不动。
 */
export function syncCatalog(db: DB, userId: number, items: CatalogInput[]) {
  return tx(db, () => {
    const upItem = db.prepare(
      `INSERT INTO taobao_items (item_id, title, status) VALUES (?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET title = excluded.title, status = excluded.status, synced_at = datetime('now', 'localtime')`,
    );
    const upSku = db.prepare(
      `INSERT INTO taobao_skus (item_id, sku_id, sku, price) VALUES (?, ?, ?, ?)
       ON CONFLICT(item_id, sku_id) DO UPDATE SET sku = excluded.sku, price = excluded.price, synced_at = datetime('now', 'localtime')`,
    );
    let skuCount = 0;
    for (const it of items) {
      const itemId = String(it.item_id ?? '').trim();
      if (!/^\d+$/.test(itemId)) continue;
      upItem.run(itemId, it.title ?? '', it.status ?? '');
      const skus = it.skus?.length ? it.skus : [{ sku_id: '', prop: '', price: '' }];
      for (const k of skus) {
        upSku.run(itemId, String(k.sku_id ?? ''), skuKey(db, itemId, k.prop ?? ''), fen(k.price));
        skuCount++;
      }
    }
    const autoMapped = autoMapSkus(db);
    log(db, userId, 'taobao_catalog', '', { items: items.length, skus: skuCount, auto_mapped: autoMapped });
    return { items: items.length, skus: skuCount, auto_mapped: autoMapped };
  });
}

/** 千牛商品页的规格名 → 子订单「商品属性」的写法：优先照卖过的订单，否则按「商品规格:xxx」 */
function skuKey(db: DB, itemId: string, prop: string): string {
  if (!prop) return '';
  const sold = db
    .prepare("SELECT sku FROM taobao_sub_orders WHERE item_id = ? AND (sku = ? OR sku LIKE '%:' || ?) LIMIT 1")
    .get(itemId, prop, prop) as { sku: string } | undefined;
  return sold?.sku ?? `商品规格:${prop}`;
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
 * 改订单实际发出的商品，任何时候都能改（待发货的也能先填好）。
 * items 为空 = 空包；as_ordered = 按下单的商品发（备注和实发无关，或改回默认）；confirm = false 只存草稿。
 * 已生成的销售单按新实发重建（日期、到账状态不变）；货已经退回来的订单不能改，要先作废那张退货单。
 */
export function setActual(
  db: DB,
  userId: number,
  orderNo: string,
  input: { items?: MapItemInput[]; as_ordered?: boolean; confirm?: boolean },
) {
  return tx(db, () => {
    const o = db.prepare('SELECT order_no FROM taobao_orders WHERE order_no = ?').get(orderNo);
    if (!o) throw new BizError('订单不存在');
    if (hasReturnedGoods(db, orderNo)) throw new BizError('这个订单有货退回来了，先作废那张退货单再改实发');
    const before = actualOf(db, orderNo);
    db.prepare('DELETE FROM taobao_actual WHERE order_no = ?').run(orderNo);
    const rows = input.as_ordered ? [] : resolveItems(db, userId, input.items ?? []);
    const ins = db.prepare('INSERT INTO taobao_actual (order_no, product_id, qty) VALUES (?, ?, ?)');
    for (const r of rows) ins.run(orderNo, r.product_id, r.qty);
    db.prepare('UPDATE taobao_orders SET actual_state = ?, actual_custom = ? WHERE order_no = ?').run(
      input.confirm === false ? 'draft' : 'confirmed',
      input.as_ordered ? 0 : 1,
      orderNo,
    );
    const after = actualOf(db, orderNo);
    log(db, userId, 'taobao_actual', orderNo, { before: before.text, after: after.text, draft: input.confirm === false });
    const rebuilt = rebuildOrder(db, userId, orderNo);
    const r = processTaobao(db, userId);
    return { ...r, rebuilt_sales: [...rebuilt, ...r.rebuilt_sales] };
  });
}

/** 订单的销售单上有没有确认退回来的货（有就不能再改实发） */
const hasReturnedGoods = (db: DB, orderNo: string) =>
  !!db
    .prepare(
      `SELECT 1 FROM docs r JOIN doc_items i ON i.doc_id = r.id JOIN docs s ON s.id = r.ref_doc_id
       WHERE r.type = 'sale_return' AND r.status = 'active' AND i.qty > 0 AND s.source = 'taobao' AND s.source_ref = ? AND s.status = 'active'`,
    )
    .get(orderNo);

/** 订单当前的实发（给日志和页面看） */
function actualOf(db: DB, orderNo: string) {
  const o = db.prepare('SELECT actual_custom FROM taobao_orders WHERE order_no = ?').get(orderNo) as { actual_custom: number };
  const rows = productNames(db, db.prepare('SELECT product_id, qty FROM taobao_actual WHERE order_no = ? ORDER BY product_id').all(orderNo) as any[]);
  const text = !o.actual_custom ? '按下单发' : rows.length ? rows.map((r) => `${r.name} ×${r.qty}`).join('、') : '空包';
  return { custom: !!o.actual_custom, rows, text };
}

/** 按订单现在的实发，重建它已生成的全部销售单 */
function rebuildOrder(db: DB, userId: number, orderNo: string): number[] {
  const o = db.prepare('SELECT * FROM taobao_orders WHERE order_no = ?').get(orderNo) as any;
  const docs = db
    .prepare(
      `SELECT DISTINCT s.sale_doc_id AS id FROM taobao_sub_orders s JOIN docs d ON d.id = s.sale_doc_id
       WHERE s.order_no = ? AND d.status = 'active' ORDER BY s.sale_doc_id`,
    )
    .all(orderNo) as { id: number }[];
  return docs.map((d) => {
    const subs = db.prepare('SELECT * FROM taobao_sub_orders WHERE sale_doc_id = ? ORDER BY sub_no').all(d.id) as unknown as SubRow[];
    return writeSale(db, userId, o, subs, postageOf(db, d.id), d.id);
  });
}

const postageOf = (db: DB, docId: number) =>
  (db.prepare("SELECT COALESCE(SUM(amount), 0) v FROM doc_adjustments WHERE doc_id = ? AND name = '邮费'").get(docId) as { v: number }).v;

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

/** 未关联商品的货款行：计入销售额（空包、实发放在同订单另一张销售单上） */
export const GOODS_PREFIX = '货款：';

/** 订单的实发是否还没确定（有商家备注没核对，或只存了草稿） */
const actualPending = (o: any) => o.actual_state === 'draft' || (!!o.remark && o.actual_state !== 'confirmed');

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
  const extra: { name: string; amount: number }[] = [];
  if (actualPending(o)) {
    for (const s of subs) unresolved.push({ name: `${UNCHECKED_PREFIX}${skuLabel(s.sku) || s.title} ×${s.qty}`, amount: s.paid });
  } else if (o.actual_custom) {
    // 实发按订单填，只挂在最先发货的那张销售单上；空包或同订单的其他销售单只记货款
    const first = db
      .prepare('SELECT sub_no FROM taobao_sub_orders WHERE order_no = ? AND shipped_at IS NOT NULL ORDER BY shipped_at, sub_no LIMIT 1')
      .get(o.order_no) as { sub_no: string };
    const total = subs.reduce((t, x) => t + x.paid, 0);
    const primary = subs.some((s) => s.sub_no === first.sub_no);
    if (primary && override.length) {
      const amounts = split(total, override.map((r) => weightOf(db, r.product_id) * r.qty));
      override.forEach((r, i) => items.push({ product_id: r.product_id, qty: r.qty, amount: amounts[i] }));
    } else {
      extra.push({ name: `${GOODS_PREFIX}${primary ? '空包' : '实发见本订单首张销售单'}`, amount: total });
    }
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
  return { items, unresolved, extra };
}

/** 这张（有未匹配项的）销售单现在是否能多确定一些商品 */
function canResolveMore(db: DB, o: any, subs: SubRow[], docId: number): boolean {
  if (actualPending(o)) return false;
  const lines = db.prepare('SELECT name FROM doc_adjustments WHERE doc_id = ?').all(docId) as { name: string }[];
  if (lines.some((l) => l.name.startsWith(UNCHECKED_PREFIX))) return true; // 实发刚确认
  if (o.actual_custom) return false;
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
    try {
      res.rebuilt_sales.push(tx(db, () => writeSale(db, userId, o, subs, postageOf(db, d.id), d.id)));
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
      : !actualPending(o) && o.actual_custom
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
       WHERE d.type = 'sale' AND d.source = 'taobao' AND d.status = 'active' AND d.review = 'unmatched' AND (j.name LIKE ? OR j.name LIKE ? OR j.name = '邮费')`,
      `${UNMATCHED_PREFIX}%`,
      `${UNCHECKED_PREFIX}%`,
    ),
    unchecked_orders: one(
      `SELECT COUNT(*) n FROM taobao_orders o WHERE (actual_state = 'draft' OR (remark != '' AND actual_state != 'confirmed'))
       AND EXISTS (SELECT 1 FROM taobao_sub_orders s WHERE s.order_no = o.order_no AND s.shipped_at IS NOT NULL)`,
    ),
    to_ship: one('SELECT COUNT(*) n FROM taobao_orders WHERE status = ?', TB_TO_SHIP),
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
  // 卖过的 SKU 和商品清单里还没卖过的 SKU 一起列（没卖过的 lines = 0）
  const skus = db
    .prepare(
      `SELECT a.item_id, a.sku, a.title,
              (SELECT COUNT(*) FROM taobao_sub_orders s WHERE s.item_id = a.item_id AND s.sku = a.sku) AS lines,
              (SELECT COALESCE(SUM(qty), 0) FROM taobao_sub_orders s WHERE s.item_id = a.item_id AND s.sku = a.sku) AS qty,
              (SELECT COUNT(*) FROM taobao_sub_orders s WHERE s.item_id = a.item_id AND s.sku = a.sku AND s.shipped_at IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM taobao_sku_map m WHERE m.item_id = s.item_id AND m.sku = s.sku AND m.confirmed = 1)) AS waiting,
              EXISTS (SELECT 1 FROM taobao_skus k WHERE k.item_id = a.item_id AND k.sku = a.sku) AS listed
       FROM (${ALL_SKUS}) a ORDER BY waiting DESC, lines DESC, a.item_id, a.sku`,
    )
    .all() as any[];
  return skus.map((s) => {
    const maps = db.prepare('SELECT product_id, qty, confirmed FROM taobao_sku_map WHERE item_id = ? AND sku = ? ORDER BY product_id').all(
      s.item_id,
      s.sku,
    ) as any[];
    const state = !maps.length ? 'none' : maps.every((m) => m.confirmed) ? 'confirmed' : 'auto';
    return {
      ...s,
      label: skuLabel(s.sku),
      state,
      products: productNames(db, maps),
      suggestions: state === 'confirmed' ? [] : suggest(db, s.title, s.sku),
    };
  });
}

/** 实发还没确定（有商家备注没核对 / 草稿）的已发货订单 */
export function listActual(db: DB) {
  const orders = db
    .prepare(
      `SELECT o.* FROM taobao_orders o WHERE (o.actual_state = 'draft' OR (o.remark != '' AND o.actual_state != 'confirmed')) AND EXISTS (
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
    suggestions: suggest(db, o.remark, ''),
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
  const lines = db.prepare("SELECT name, amount FROM doc_adjustments WHERE doc_id = ? AND (name LIKE ? OR name LIKE ? OR name = '邮费') ORDER BY id");
  return docs.map((d) => ({ ...d, lines: lines.all(d.id, `${UNMATCHED_PREFIX}%`, `${UNCHECKED_PREFIX}%`) }));
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


/** 订单列表的分组（按淘宝订单状态） */
export const ORDER_GROUPS: Record<string, string> = {
  to_ship: `status = '${TB_TO_SHIP}'`,
  shipped: `(status LIKE '卖家已发货%' OR status LIKE '卖家部分发货%')`,
  success: `status = '${TB_SUCCESS}'`,
  closed: `status LIKE '交易关闭%'`,
  other: `status NOT IN ('${TB_TO_SHIP}', '${TB_SUCCESS}') AND status NOT LIKE '卖家已发货%' AND status NOT LIKE '卖家部分发货%' AND status NOT LIKE '交易关闭%'`,
};

/** 淘宝订单列表：按分组 / 订单号或商品关键字筛，最新的在前 */
export function listOrders(db: DB, opts: { group?: string; q?: string; offset?: number }) {
  const where = [ORDER_GROUPS[opts.group ?? ''] ?? '1 = 1'];
  const params: string[] = [];
  if (opts.q?.trim()) {
    where.push(`(o.order_no LIKE ? OR o.remark LIKE ? OR EXISTS (SELECT 1 FROM taobao_sub_orders s WHERE s.order_no = o.order_no AND (s.title LIKE ? OR s.sku LIKE ?)))`);
    const q = `%${opts.q.trim()}%`;
    params.push(q, q, q, q);
  }
  const orders = db
    .prepare(
      `SELECT o.* FROM taobao_orders o WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(o.shipped_at, o.paid_at, o.created_at) DESC, o.order_no DESC LIMIT 50 OFFSET ?`,
    )
    .all(...params, opts.offset ?? 0) as any[];
  const counts = Object.fromEntries(
    Object.entries(ORDER_GROUPS).map(([k, cond]) => [k, (db.prepare(`SELECT COUNT(*) n FROM taobao_orders WHERE ${cond}`).get() as { n: number }).n]),
  );
  return {
    counts,
    items: orders.map((o) => ({
      ...o,
      subs: (db.prepare('SELECT * FROM taobao_sub_orders WHERE order_no = ? ORDER BY sub_no').all(o.order_no) as any[]).map((s) => ({
        sub_no: s.sub_no,
        title: s.title,
        qty: s.qty,
        paid: s.paid,
        refund_status: s.refund_status,
        label: skuLabel(s.sku),
        products: productNames(db, confirmedMap(db, s)),
      })),
      actual_text: actualOf(db, o.order_no).text,
    })),
  };
}

/** 订单详情：子订单（含对照的商品）、实发、生成的销售单和退款、修改记录 */
export function getOrder(db: DB, orderNo: string) {
  const o = db.prepare('SELECT * FROM taobao_orders WHERE order_no = ?').get(orderNo) as any;
  if (!o) return null;
  const subs = (db.prepare('SELECT * FROM taobao_sub_orders WHERE order_no = ? ORDER BY sub_no').all(orderNo) as any[]).map((s) => ({
    ...s,
    label: skuLabel(s.sku),
    products: productNames(db, confirmedMap(db, s)),
    suggestions: confirmedMap(db, s).length ? [] : suggest(db, s.title, s.sku),
  }));
  const docs = db
    .prepare(
      `SELECT id, type, doc_date, amount, status, review, received FROM docs
       WHERE source = 'taobao' AND source_ref = ? ORDER BY id`,
    )
    .all(orderNo);
  const logs = db
    .prepare(
      `SELECT l.created_at, l.detail, u.name AS user_name FROM logs l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.action = 'taobao_actual' AND l.target = ? ORDER BY l.id DESC`,
    )
    .all(orderNo);
  return {
    order: { ...o, pending: actualPending(o) },
    subs,
    actual: actualOf(db, orderNo),
    remark_suggestions: o.remark ? suggest(db, o.remark, '') : [],
    docs,
    logs,
    returned: hasReturnedGoods(db, orderNo),
  };
}
