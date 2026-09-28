import type { DB } from './db.ts';
import { tx, log } from './db.ts';

// 奥乐齐小程序的公开商品接口（免登录），来源见 ~/.claude/skills/aldi-product
const HOST = 'https://m.aldi.com.cn';
const PLATFORM_ID = 3;
const COMPANY_ID = 135;
export const DEFAULT_STORE = '2209090003895146'; // 上海苏河湾店，品类最全

// 促销 / 活动类目不是真正的商品分类，跳过
const PROMO = /专区|预售|清仓|赏味|上新|推荐|特价|秒杀|爆款|必买|热卖|新品|囤货|会员/;

async function get(path: string, params: Record<string, string | number>) {
  const url = `${HOST}${path}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'P-System': 'weChat', 'User-Agent': 'Mozilla/5.0 (iPhone) MiniProgramEnv/iOS', Accept: '*/*' },
        signal: AbortSignal.timeout(25_000),
      });
      const body = (await res.json()) as { code: string | number; message?: string; data: any };
      if (String(body.code) !== '0') throw new Error(`奥乐齐接口返回 ${body.code} ${body.message ?? ''}`);
      return body.data;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw last;
}

interface Category {
  id: string;
  name: string;
}

async function categories(parent: string | number, level: number, store: string): Promise<Category[]> {
  const d = await get('/back-product-web2/mp/category/list', { parentId: parent, level, companyId: COMPANY_ID, merchantId: store });
  return ((d?.categorys ?? []) as any[]).map((c) => ({ id: String(c.categoryId), name: String(c.categoryName) }));
}

export interface AldiProduct {
  mpId: string;
  code: string;
  name: string;
  sell: string;
  brand: string;
  img: string | null;
}

async function categoryProducts(catId: string, store: string): Promise<AldiProduct[]> {
  const out: AldiProduct[] = [];
  for (let page = 1; page <= 50; page++) {
    const d = await get('/search/rest/queryProductList', {
      mCategoryIds: catId,
      pageNo: page,
      pageSize: 50,
      sortType: 25,
      hasPromotion: 0,
      merchantId: store,
      companyId: COMPANY_ID,
      platformId: PLATFORM_ID,
      v: 2,
    });
    const block = (d ?? [])[0] ?? {};
    const list = (block.productList ?? []) as any[];
    for (const p of list) {
      out.push({
        mpId: String(p.mpId),
        code: String(p.code ?? ''),
        name: String(p.name ?? '').trim(),
        sell: String(p.productSell ?? '').trim(),
        brand: String(p.brandName ?? '').trim(),
        img: p.url800x800 || p.picUrl || null,
      });
    }
    if (!list.length || page * 50 >= (block.totalCount ?? 0)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return out;
}

/** 从商品名末尾取规格，如「超值 手撕猪肉脯150g」→ 150g，「xx 330ml*6」→ 330ml*6 */
export function parseSpec(name: string): string {
  const unit = '(?:kg|g|ml|l|克|千克|毫升|升|粒|片|支|袋|包|盒|瓶|只|个|枚|卷|抽|条|罐|听|斤|入|件|双|张)';
  const m = name.match(new RegExp(`(\\d+(?:\\.\\d+)?\\s*${unit}(?:\\s*[*×xX]\\s*\\d+(?:\\.\\d+)?\\s*${unit}?)?)\\s*$`, 'i'));
  return m ? m[1].replace(/\s+/g, '') : '';
}

export interface SyncResult {
  categories: number;
  fetched: number;
  created: number;
  updated: number;
  ms: number;
}

/**
 * 把奥乐齐的「一级/二级」类目和商品同步进参考商品库 catalog_items（不同步价格）。
 * 参考库只供扫码 / 搜索时查询和一键建档，不会进商品表，也不参与库存和统计。
 */
export async function syncAldi(db: DB, userId: number | null, opts: { store?: string; onProgress?: (msg: string) => void } = {}): Promise<SyncResult> {
  const t0 = Date.now();
  const store = opts.store ?? DEFAULT_STORE;
  const progress = opts.onProgress ?? (() => {});
  const byId = new Map<string, AldiProduct & { category: string }>();
  let catCount = 0;

  for (const c1 of await categories(0, 1, store)) {
    if (PROMO.test(c1.name)) continue;
    const subs = (await categories(c1.id, 2, store)).filter((c) => !PROMO.test(c.name));
    for (const c2 of subs.length ? subs : [c1]) {
      const category = c2 === c1 ? c1.name : `${c1.name}/${c2.name}`;
      progress(`抓取 ${category}`);
      catCount++;
      for (const p of await categoryProducts(c2.id, store)) {
        // 同一商品出现在多个类目时，保留第一次遇到的
        if (p.name && !byId.has(p.mpId)) byId.set(p.mpId, { ...p, category });
      }
    }
  }
  if (!byId.size) throw new Error('没有从奥乐齐抓到商品，接口可能变了');

  let created = 0;
  let updated = 0;
  tx(db, () => {
    const exists = db.prepare("SELECT 1 FROM catalog_items WHERE source = 'aldi' AND source_id = ?");
    const upsert = db.prepare(
      `INSERT INTO catalog_items (source, source_id, name, spec, category, brand, sku_code, image_url, sell)
       VALUES ('aldi', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, source_id) DO UPDATE SET name = excluded.name, spec = excluded.spec, category = excluded.category,
         brand = excluded.brand, sku_code = excluded.sku_code, image_url = excluded.image_url, sell = excluded.sell,
         synced_at = datetime('now', 'localtime')`,
    );
    for (const p of byId.values()) {
      if (exists.get(p.mpId)) updated++;
      else created++;
      upsert.run(p.mpId, p.name, parseSpec(p.name), p.category, p.brand, p.code || null, p.img, p.sell);
    }
    log(db, userId, 'sync_aldi', '', { categories: catCount, fetched: byId.size, created, updated });
  });

  return { categories: catCount, fetched: byId.size, created, updated, ms: Date.now() - t0 };
}
