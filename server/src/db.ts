import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { replayProduct, landedCosts } from './inventory.ts';
import { USERS, DEFAULT_PASSWORD } from './settings.ts';
import { hashPassword } from './auth.ts';

// 金额一律以「分」为整数存储
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,            -- public | person
  name TEXT NOT NULL,
  user_id INTEGER
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  barcode TEXT UNIQUE,
  spec TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  image_upload_id INTEGER,
  ref_price INTEGER,
  note TEXT NOT NULL DEFAULT '',
  stock_qty INTEGER NOT NULL DEFAULT 0,
  stock_value INTEGER NOT NULL DEFAULT 0,
  last_cost INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS product_aliases (
  alias TEXT PRIMARY KEY,
  product_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  doc_date TEXT NOT NULL,
  account_id INTEGER,
  to_account_id INTEGER,
  amount INTEGER NOT NULL DEFAULT 0,
  channel TEXT NOT NULL DEFAULT '',
  counterparty TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  voided_by INTEGER,
  voided_at TEXT,
  void_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_docs_type ON docs(type, status);
CREATE TABLE IF NOT EXISTS doc_items (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,          -- 盘点为带符号差异，其余为正数
  unit_price INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL DEFAULT 0,
  cost_amount INTEGER NOT NULL DEFAULT 0,
  cost_pending INTEGER NOT NULL DEFAULT 0,
  counted_qty INTEGER,
  raw_name TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_items_doc ON doc_items(doc_id);
CREATE INDEX IF NOT EXISTS idx_items_product ON doc_items(product_id);
-- 进货单的额外费用（正数，运费等）/ 减免（负数，优惠券等）；docs.amount 是实付，商品成本只看明细
CREATE TABLE IF NOT EXISTS doc_adjustments (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adjustments_doc ON doc_adjustments(doc_id);
CREATE TABLE IF NOT EXISTS uploads (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER,
  kind TEXT NOT NULL,            -- receipt | sale_shot | expense | product | other
  path TEXT NOT NULL,
  orig_path TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_uploads_doc ON uploads(doc_id);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`;

export type DB = DatabaseSync;

export function openDb(dataDir: string): DB {
  let db: DB;
  if (dataDir === ':memory:') {
    db = new DatabaseSync(':memory:');
  } else {
    mkdirSync(join(dataDir, 'uploads'), { recursive: true });
    db = new DatabaseSync(join(dataDir, 'kucun.db'));
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  return db;
}

/** 给老库补字段：只加不删 */
function migrate(db: DB) {
  const cols = new Set((db.prepare('PRAGMA table_info(products)').all() as { name: string }[]).map((c) => c.name));
  const add = (name: string, def: string) => {
    if (!cols.has(name)) db.exec(`ALTER TABLE products ADD COLUMN ${name} ${def}`);
  };
  add('sku_code', 'TEXT'); // 商家货号（如奥乐齐 10008423），小票上可能印的是它
  add('brand', "TEXT NOT NULL DEFAULT ''");
  add('image_url', 'TEXT'); // 外部图片地址（同步来的商品图）
  add('source', 'TEXT'); // 同步来源，如 aldi
  add('source_id', 'TEXT'); // 来源里的商品 ID
  db.exec('CREATE INDEX IF NOT EXISTS idx_products_source ON products(source, source_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku_code)');

  // 外部参考商品库（如奥乐齐全量商品）：只供搜索和一键建档，不参与库存和统计
  db.exec(`CREATE TABLE IF NOT EXISTS catalog_items (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    name TEXT NOT NULL,
    spec TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    brand TEXT NOT NULL DEFAULT '',
    sku_code TEXT,
    image_url TEXT,
    sell TEXT NOT NULL DEFAULT '',
    synced_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (source, source_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_catalog_sku ON catalog_items(sku_code)');

  const addTo = (table: string, name: string, def: string) => {
    const has = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === name);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  };
  addTo('docs', 'source', 'TEXT'); // 导入来源：taobao；这类单据由导入维护，不能手动作废
  addTo('docs', 'source_ref', 'TEXT'); // 来源单号：淘宝主订单号
  addTo('docs', 'ref_doc_id', 'INTEGER'); // 退货单 → 原销售单
  addTo('docs', 'received', 'INTEGER'); // 销售单：0 = 钱未到账（淘宝应收），NULL / 1 = 已到账
  addTo('docs', 'received_at', 'TEXT');
  addTo('docs', 'review', "TEXT NOT NULL DEFAULT ''"); // pending = 导入自动生成、待人工确认的退款
  addTo('doc_items', 'ref_item_id', 'INTEGER'); // 退货明细 → 原销售明细
  addTo('doc_items', 'in_cost', 'INTEGER'); // 退货明细：退回入库的成本（用户可改）
  addTo('doc_items', 'source_ref', 'TEXT'); // 淘宝销售明细：子订单号
  db.exec('CREATE INDEX IF NOT EXISTS idx_docs_source ON docs(source, source_ref)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_docs_ref ON docs(ref_doc_id)');

  // 淘宝订单原始数据（千牛导出的主订单表 + 子订单表），金额单位分
  db.exec(`CREATE TABLE IF NOT EXISTS taobao_orders (
    order_no TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    paid INTEGER NOT NULL DEFAULT 0,       -- 买家实付（含邮费）
    postage INTEGER NOT NULL DEFAULT 0,    -- 买家应付邮费
    payout INTEGER NOT NULL DEFAULT 0,     -- 确认收货打款金额
    refund INTEGER NOT NULL DEFAULT 0,
    created_at TEXT, paid_at TEXT, shipped_at TEXT, confirmed_at TEXT,
    remark TEXT NOT NULL DEFAULT '',       -- 商家备注
    close_reason TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    actual_state TEXT NOT NULL DEFAULT '', -- 有备注时的实发：'' 未填 / draft 草稿 / confirmed 已确认
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS taobao_sub_orders (
    sub_no TEXT PRIMARY KEY,
    order_no TEXT NOT NULL,
    item_id TEXT NOT NULL,
    sku TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL DEFAULT 0,
    qty INTEGER NOT NULL,
    paid INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    refund_status TEXT NOT NULL DEFAULT '',
    refund INTEGER NOT NULL DEFAULT 0,
    shipped_at TEXT,
    sale_doc_id INTEGER,
    refund_doc_id INTEGER
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tb_sub_order ON taobao_sub_orders(order_no)');
  // 淘宝 SKU（商品ID + 规格）→ 库存商品 × 件数；套装对应多行。confirmed = 0 是自动匹配、待确认
  db.exec(`CREATE TABLE IF NOT EXISTS taobao_sku_map (
    item_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    confirmed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (item_id, sku, product_id)
  )`);
  backfillLandedCost(db);
  addTo('taobao_orders', 'fake', 'INTEGER NOT NULL DEFAULT 0'); // 1 = 刷单：不算销售额，回款冲抵刷单返款
  // 商家备注里写了「实际发…」的订单 / 刷单实际发出的商品
  db.exec(`CREATE TABLE IF NOT EXISTS taobao_actual (
    order_no TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    PRIMARY KEY (order_no, product_id)
  )`);
}

/** 老的进货单：按实付重新算每行成本（优惠 / 运费摊进商品），然后重放受影响的商品 */
function backfillLandedCost(db: DB) {
  const docs = db
    .prepare(
      `SELECT DISTINCT d.id FROM docs d JOIN doc_items i ON i.doc_id = d.id WHERE d.type = 'purchase' AND i.in_cost IS NULL`,
    )
    .all() as { id: number }[];
  if (!docs.length) return;
  const touched = new Set<number>();
  db.exec('BEGIN');
  try {
    for (const { id } of docs) {
      const items = db.prepare('SELECT id, amount, product_id FROM doc_items WHERE doc_id = ? ORDER BY id').all(id) as {
        id: number;
        amount: number;
        product_id: number;
      }[];
      const adj = (db.prepare('SELECT COALESCE(SUM(amount), 0) v FROM doc_adjustments WHERE doc_id = ?').get(id) as { v: number }).v;
      const costs = landedCosts(items.map((i) => i.amount), adj);
      items.forEach((it, k) => {
        db.prepare('UPDATE doc_items SET in_cost = ? WHERE id = ?').run(costs[k], it.id);
        touched.add(it.product_id);
      });
    }
    for (const pid of touched) replayProduct(db, pid);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function seed(db: DB) {
  const hasPublic = db.prepare("SELECT 1 FROM accounts WHERE kind = 'public'").get();
  if (!hasPublic) db.prepare("INSERT INTO accounts (kind, name) VALUES ('public', '公共资金')").run();
  for (const u of USERS) {
    let row = db.prepare('SELECT id FROM users WHERE username = ?').get(u.username) as { id: number } | undefined;
    if (row) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(u.name, row.id);
      db.prepare("UPDATE accounts SET name = ? WHERE kind = 'person' AND user_id = ?").run(u.name, row.id);
    } else {
      const r = db
        .prepare('INSERT INTO users (username, name, password_hash) VALUES (?, ?, ?)')
        .run(u.username, u.name, hashPassword(DEFAULT_PASSWORD));
      row = { id: Number(r.lastInsertRowid) };
    }
    const acc = db.prepare("SELECT 1 FROM accounts WHERE kind = 'person' AND user_id = ?").get(row.id);
    if (!acc) db.prepare("INSERT INTO accounts (kind, name, user_id) VALUES ('person', ?, ?)").run(u.name, row.id);
  }
}

const txDepth = new WeakMap<DB, number>();

/** 事务；嵌套调用时用保存点，内层失败只回滚内层 */
export function tx<T>(db: DB, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  const sp = `sp${depth}`;
  db.exec(depth ? `SAVEPOINT ${sp}` : 'BEGIN');
  txDepth.set(db, depth + 1);
  try {
    const r = fn();
    db.exec(depth ? `RELEASE ${sp}` : 'COMMIT');
    return r;
  } catch (e) {
    db.exec(depth ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
    throw e;
  } finally {
    txDepth.set(db, depth);
  }
}

/** 试跑：执行 fn 后整体回滚，返回 fn 的结果 */
export function dryRun<T>(db: DB, fn: () => T): T {
  const DRY = Symbol('dry');
  let result: T;
  try {
    tx(db, () => {
      result = fn();
      throw DRY;
    });
  } catch (e) {
    if (e !== DRY) throw e;
  }
  return result!;
}

export function log(db: DB, userId: number | null, action: string, target = '', detail: unknown = '') {
  db.prepare('INSERT INTO logs (user_id, action, target, detail) VALUES (?, ?, ?, ?)').run(
    userId,
    action,
    target,
    typeof detail === 'string' ? detail : JSON.stringify(detail),
  );
}
