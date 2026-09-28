import type { DB } from './db.ts';
import { log } from './db.ts';
import { normalizeName, BizError } from './docs.ts';
import { nameScore } from './vision.ts';

// 参考商品库（奥乐齐等）：只供查询和一键建档；建档后才进商品表

export interface CatalogItem {
  id: number;
  source: string;
  source_id: string;
  name: string;
  spec: string;
  category: string;
  brand: string;
  sku_code: string | null;
  image_url: string | null;
  sell: string;
  product_id?: number | null; // 已建档时对应的商品
}

const SELECT = `SELECT c.*, (SELECT p.id FROM products p WHERE p.source = c.source AND p.source_id = c.source_id) AS product_id FROM catalog_items c`;

export function getCatalogItem(db: DB, id: number): CatalogItem | undefined {
  return db.prepare(`${SELECT} WHERE c.id = ?`).get(id) as CatalogItem | undefined;
}

/** 名称 / 品牌 / 货号 / 类目模糊搜，再用简称和相似度兜底 */
export function searchCatalog(db: DB, q: string, limit = 20): CatalogItem[] {
  const key = normalizeName(q);
  if (!key) return [];
  const like = `%${q.trim()}%`;
  const rows = db
    .prepare(`${SELECT} WHERE c.name LIKE ? OR c.brand LIKE ? OR c.sku_code = ? OR c.category LIKE ? LIMIT ?`)
    .all(like, like, q.trim(), like, limit) as unknown as CatalogItem[];
  if (rows.length >= limit || key.length < 2) return rows;
  const seen = new Set(rows.map((r) => r.id));
  const all = db.prepare(SELECT).all() as unknown as CatalogItem[];
  const scored = all
    .filter((c) => !seen.has(c.id))
    .map((c) => {
      return { c, s: nameScore(key, normalizeName(c.name)) };
    })
    .filter((x) => x.s >= 0.35)
    .sort((a, b) => b.s - a.s);
  return [...rows, ...scored.slice(0, limit - rows.length).map((x) => x.c)];
}

/** 识别出的一行在参考库里找最像的：货号精确命中，或名称足够像且领先明显 */
export function matchCatalog(db: DB, name: string, code?: string) {
  if (code) {
    const hit = db.prepare(`${SELECT} WHERE c.sku_code = ?`).get(code) as CatalogItem | undefined;
    if (hit) return { item: hit, candidates: [] as CatalogItem[] };
  }
  const key = normalizeName(name);
  if (!key) return { item: null, candidates: [] as CatalogItem[] };
  const all = db.prepare(SELECT).all() as unknown as CatalogItem[];
  const scored = all
    .map((c) => ({ c, s: nameScore(key, normalizeName(c.name)) }))
    .filter((x) => x.s >= 0.35)
    .sort((a, b) => b.s - a.s);
  const top = scored[0];
  const clear = top && top.s >= 0.75 && (!scored[1] || top.s - scored[1].s >= 0.1);
  return { item: clear ? top.c : null, candidates: scored.slice(0, 3).map((x) => x.c) };
}

/** 从参考库建档；已建过就复用那个商品。带条码时顺便绑定（商品还没有条码的话） */
export function productFromCatalog(db: DB, userId: number, catalogId: number, barcode?: string | null): number {
  const c = getCatalogItem(db, catalogId);
  if (!c) throw new BizError('参考库里没有这个商品');
  const code = barcode?.trim() || null;
  if (code) {
    const other = db.prepare('SELECT id, name FROM products WHERE barcode = ?').get(code) as { id: number; name: string } | undefined;
    if (other && other.id !== c.product_id) throw new BizError(`条码已被「${other.name}」使用`);
  }
  if (c.product_id) {
    if (code) db.prepare('UPDATE products SET barcode = COALESCE(barcode, ?) WHERE id = ?').run(code, c.product_id);
    return c.product_id;
  }
  const r = db
    .prepare(
      `INSERT INTO products (name, barcode, spec, category, note, sku_code, brand, image_url, source, source_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(c.name, code, c.spec, c.category, c.sell, c.sku_code, c.brand, c.image_url, c.source, c.source_id);
  const id = Number(r.lastInsertRowid);
  log(db, userId, 'create_product', `product:${id}`, `从参考库建档：${c.name}`);
  return id;
}

export function catalogStats(db: DB) {
  return db
    .prepare(`SELECT source, COUNT(*) AS count, MAX(synced_at) AS synced_at FROM catalog_items GROUP BY source`)
    .all() as { source: string; count: number; synced_at: string }[];
}
