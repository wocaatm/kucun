import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb, log, tx, dryRun, type DB } from './db.ts';
import { verifyPassword, hashPassword, newToken } from './auth.ts';
import { createDoc, createReturn, voidDoc, getDoc, BizError, normalizeName, type DocInput } from './docs.ts';
import { accountBalances, settleSuggestions, profit, inventorySummary, capital, receivable } from './ledger.ts';
import { readXlsx } from './xlsx.ts';
import * as taobao from './taobao.ts';
import * as agent from './agent.ts';
import { avgCost, replayProduct } from './inventory.ts';
import { recognizeImage, matchProduct, isSubsequence, type RecognizeMode } from './vision.ts';
import { createBackup, listBackups } from './backup.ts';
import { syncAldi } from './aldi.ts';
import { searchCatalog, matchCatalog, getCatalogItem, productFromCatalog, catalogStats } from './catalog.ts';
import {
  SESSION_DAYS,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  SALE_CHANNELS,
  OUTBOUND_CATEGORIES,
  PROFIT_SHARES,
  LOW_STOCK_THRESHOLD,
} from './settings.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: number; username: string; name: string };
  }
}

export interface AppOptions {
  dataDir: string;
  webDir?: string;
  recognize?: typeof recognizeImage;
}

const UPLOAD_KINDS = ['receipt', 'sale_shot', 'expense', 'product', 'other'];

export function buildApp(opts: AppOptions) {
  const dataDir = opts.dataDir;
  const db: DB = openDb(dataDir);
  const recognize = opts.recognize ?? recognizeImage;
  const uploadRoot = join(dataDir, 'uploads');

  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  app.decorate('db', db);
  app.register(cookie);
  app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 2 } });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof BizError) return reply.status(400).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    console.error(err);
    reply.status(500).send({ error: err.message || '服务器出错' });
  });

  // ---------- 鉴权 ----------
  const PUBLIC = new Set(['/api/auth/login']);
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!(path.startsWith('/api/') || path.startsWith('/files/')) || PUBLIC.has(path)) return;
    // 淘宝插件：只认连接码，身份是生成连接码的人
    if (path.startsWith('/api/agent/')) {
      const u = agent.agentUser(db, req.headers.authorization?.replace(/^Bearer\s+/i, ''));
      if (!u) return reply.status(401).send({ error: '连接码不对或已重置，请在「我的 → 淘宝插件」复制新的连接码' });
      req.user = u;
      return;
    }
    const token = req.cookies.sid;
    const row = token
      ? (db
          .prepare(
            `SELECT u.id, u.username, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`,
          )
          .get(token, Date.now()) as FastifyRequest['user'] | undefined)
      : undefined;
    if (!row) return reply.status(401).send({ error: '请先登录' });
    req.user = row;
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username?.trim() ?? '') as
      | { id: number; username: string; name: string; password_hash: string }
      | undefined;
    if (!u || !password || !verifyPassword(password, u.password_hash)) return reply.status(400).send({ error: '账号或密码错误' });
    const token = newToken();
    const maxAge = SESSION_DAYS * 86400;
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, u.id, Date.now() + maxAge * 1000);
    log(db, u.id, 'login');
    reply.setCookie('sid', token, { path: '/', httpOnly: true, sameSite: 'lax', maxAge });
    return { user: { id: u.id, username: u.username, name: u.name } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid ?? '');
    reply.clearCookie('sid', { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => ({ user: req.user }));

  app.post('/api/me/password', async (req) => {
    const { old_password, new_password } = req.body as { old_password: string; new_password: string };
    const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id) as { password_hash: string };
    if (!verifyPassword(old_password ?? '', u.password_hash)) throw new BizError('原密码不正确');
    if (!new_password || new_password.length < 6) throw new BizError('新密码至少 6 位');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(new_password), req.user.id);
    log(db, req.user.id, 'change_password');
    return { ok: true };
  });

  // ---------- 元数据 ----------
  app.get('/api/meta', async () => ({
    accounts: accountBalances(db),
    users: db.prepare('SELECT id, username, name FROM users').all(),
    expense_categories: EXPENSE_CATEGORIES,
    income_categories: INCOME_CATEGORIES,
    sale_channels: SALE_CHANNELS,
    outbound_categories: OUTBOUND_CATEGORIES,
    profit_shares: PROFIT_SHARES,
    low_stock_threshold: LOW_STOCK_THRESHOLD,
    vision_enabled: !!process.env.VISION_API_KEY || !!opts.recognize,
    catalogs: catalogStats(db),
  }));

  // ---------- 商品 ----------
  const withAvg = (p: any) => (p ? { ...p, avg_cost: avgCost(p) } : p);

  const productFields = (b: any) => {
    const name = String(b.name ?? '').trim();
    if (!name) throw new BizError('商品名称不能为空');
    const barcode = String(b.barcode ?? '').trim() || null;
    return {
      name,
      barcode,
      spec: String(b.spec ?? '').trim(),
      category: String(b.category ?? '').trim(),
      ref_price: Number.isInteger(b.ref_price) ? b.ref_price : null,
      note: String(b.note ?? ''),
      image_upload_id: Number.isInteger(b.image_upload_id) ? b.image_upload_id : null,
      sku_code: String(b.sku_code ?? '').trim() || null,
      brand: String(b.brand ?? '').trim(),
      image_url: String(b.image_url ?? '').trim() || null,
    };
  };

  const assertBarcodeFree = (barcode: string | null, selfId?: number) => {
    if (!barcode) return;
    const other = db.prepare('SELECT id, name FROM products WHERE barcode = ?').get(barcode) as { id: number; name: string } | undefined;
    if (other && other.id !== selfId) throw new BizError(`条码已被「${other.name}」使用`);
  };

  // 有过进出记录的商品排前面，其次按最近修改
  const PRODUCT_ORDER = `ORDER BY EXISTS (SELECT 1 FROM doc_items i WHERE i.product_id = p.id) DESC, p.updated_at DESC, p.id DESC`;

  app.get('/api/products', async (req) => {
    const { q = '', filter = '', category = '', offset = '0', limit = '50' } = req.query as Record<string, string>;
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.trim()) {
      where.push('(p.name LIKE ? OR p.barcode LIKE ? OR p.sku_code LIKE ? OR p.spec LIKE ? OR p.category LIKE ? OR p.brand LIKE ?)');
      const like = `%${q.trim()}%`;
      params.push(like, like, like, like, like, like);
    }
    if (category) {
      where.push('(p.category = ? OR p.category LIKE ?)');
      params.push(category, `${category}/%`);
    }
    if (filter === 'negative') where.push('p.stock_qty < 0');
    if (filter === 'instock') where.push('p.stock_qty > 0');
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const lim = Math.min(Number(limit) || 50, 200);
    const off = Number(offset) || 0;
    const rows: any[] = db.prepare(`SELECT p.* FROM products p ${whereSql} ${PRODUCT_ORDER} LIMIT ? OFFSET ?`).all(...params, lim, off);
    // 简称兜底：「维C」也能搜到「KS 维生素C」（只在第一页补）
    const key = normalizeName(q);
    if (off === 0 && key.length >= 2 && rows.length < 20) {
      const seen = new Set(rows.map((r: any) => r.id));
      const extra = (db.prepare(`SELECT p.* FROM products p ${PRODUCT_ORDER}`).all() as any[]).filter(
        (p) => !seen.has(p.id) && isSubsequence(key, normalizeName(p.name)),
      );
      rows.push(...extra.slice(0, 20 - rows.length));
    }
    return { items: rows.map(withAvg), has_more: rows.length >= lim };
  });

  /** 类目树：「一级/二级」拆开统计 */
  app.get('/api/products/categories', async () => {
    const rows = db
      .prepare(
        `SELECT category, COUNT(*) AS n FROM (SELECT category FROM products UNION ALL SELECT category FROM catalog_items)
         WHERE category != '' GROUP BY category ORDER BY category`,
      )
      .all() as { category: string; n: number }[];
    const tree = new Map<string, { name: string; count: number; children: { name: string; count: number }[] }>();
    for (const r of rows) {
      const [top, ...rest] = r.category.split('/');
      const sub = rest.join('/');
      if (!tree.has(top)) tree.set(top, { name: top, count: 0, children: [] });
      const node = tree.get(top)!;
      node.count += r.n;
      if (sub) node.children.push({ name: sub, count: r.n });
    }
    return { items: [...tree.values()] };
  });

  // 扫码查商品：先按条码，再按商家货号（奥乐齐商品只有货号）
  app.get('/api/products/barcode/:code', async (req) => {
    const code = (req.params as any).code;
    const p = db.prepare('SELECT * FROM products WHERE barcode = ?').get(code) ?? db.prepare('SELECT * FROM products WHERE sku_code = ?').get(code);
    if (p) return { product: withAvg(p), catalog: null };
    const c = db.prepare('SELECT id FROM catalog_items WHERE sku_code = ?').get(code) as { id: number } | undefined;
    return { product: null, catalog: c ? getCatalogItem(db, c.id) : null };
  });

  /** 把扫到的条码绑定到已有商品（同步来的商品没有条码） */
  app.post('/api/products/:id/barcode', async (req) => {
    const id = Number((req.params as any).id);
    const barcode = String((req.body as any)?.barcode ?? '').trim();
    if (!barcode) throw new BizError('条码不能为空');
    assertBarcodeFree(barcode, id);
    db.prepare(`UPDATE products SET barcode = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`).run(barcode, id);
    log(db, req.user.id, 'bind_barcode', `product:${id}`, barcode);
    return { product: withAvg(db.prepare('SELECT * FROM products WHERE id = ?').get(id)) };
  });

  app.get('/api/catalog', async (req) => {
    const { q = '', limit = '20' } = req.query as Record<string, string>;
    return { items: searchCatalog(db, q, Math.min(Number(limit) || 20, 50)) };
  });

  app.post('/api/sync/aldi', async (req) => {
    return syncAldi(db, req.user.id);
  });

  app.get('/api/products/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!p) return reply.status(404).send({ error: '商品不存在' });
    const moves = db
      .prepare(
        `SELECT i.*, d.type, d.category, d.doc_date, d.status, d.channel, u.name AS created_by_name
         FROM doc_items i JOIN docs d ON d.id = i.doc_id JOIN users u ON u.id = d.created_by
         WHERE i.product_id = ? ORDER BY d.doc_date DESC, d.id DESC LIMIT 200`,
      )
      .all(id);
    // 进货记录：每次进了多少、实付单价（优惠 / 运费已摊进去）
    const purchases = db
      .prepare(
        `SELECT d.id AS doc_id, d.type, d.doc_date, d.counterparty, d.channel, i.qty, COALESCE(i.in_cost, i.amount) AS cost, a.name AS account_name
         FROM doc_items i JOIN docs d ON d.id = i.doc_id LEFT JOIN accounts a ON a.id = d.account_id
         WHERE i.product_id = ? AND d.status = 'active' AND d.type IN ('purchase', 'opening_stock') AND i.qty > 0
         ORDER BY d.doc_date DESC, d.id DESC`,
      )
      .all(id);
    return { product: withAvg(p), moves, purchases };
  });

  app.post('/api/products', async (req) => {
    const body = req.body as any;
    // 从参考库一键建档
    if (Number.isInteger(body?.catalog_id)) {
      const id = productFromCatalog(db, req.user.id, body.catalog_id, body.barcode);
      return { product: withAvg(db.prepare('SELECT * FROM products WHERE id = ?').get(id)) };
    }
    const f = productFields(body);
    assertBarcodeFree(f.barcode);
    const r = db
      .prepare(
        'INSERT INTO products (name, barcode, spec, category, ref_price, note, image_upload_id, sku_code, brand, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(f.name, f.barcode, f.spec, f.category, f.ref_price, f.note, f.image_upload_id, f.sku_code, f.brand, f.image_url);
    const id = Number(r.lastInsertRowid);
    log(db, req.user.id, 'create_product', `product:${id}`, f.name);
    return { product: withAvg(db.prepare('SELECT * FROM products WHERE id = ?').get(id)) };
  });

  app.put('/api/products/:id', async (req) => {
    const id = Number((req.params as any).id);
    const f = productFields(req.body);
    assertBarcodeFree(f.barcode, id);
    db.prepare(
      `UPDATE products SET name = ?, barcode = ?, spec = ?, category = ?, ref_price = ?, note = ?, image_upload_id = ?,
       sku_code = ?, brand = ?, image_url = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
    ).run(f.name, f.barcode, f.spec, f.category, f.ref_price, f.note, f.image_upload_id, f.sku_code, f.brand, f.image_url, id);
    log(db, req.user.id, 'update_product', `product:${id}`, f.name);
    return { product: withAvg(db.prepare('SELECT * FROM products WHERE id = ?').get(id)) };
  });

  /** Excel 导入：按条码、再按名称匹配已有商品；带期初数量的行合成一张期初库存单 */
  app.post('/api/products/import', async (req) => {
    const { rows } = req.body as { rows: any[] };
    if (!Array.isArray(rows) || !rows.length) throw new BizError('没有可导入的数据');
    let created = 0;
    let updated = 0;
    const opening: { product_id: number; qty: number; unit_price: number }[] = [];
    tx(db, () => {
      for (const row of rows) {
        const f = productFields(row);
        let existing = (f.barcode ? db.prepare('SELECT id FROM products WHERE barcode = ?').get(f.barcode) : undefined) as
          | { id: number }
          | undefined;
        if (!existing) existing = db.prepare('SELECT id FROM products WHERE name = ? AND spec = ?').get(f.name, f.spec) as any;
        let id: number;
        if (existing) {
          id = existing.id;
          db.prepare(
            `UPDATE products SET name = ?, barcode = COALESCE(?, barcode), spec = ?, category = COALESCE(NULLIF(?, ''), category),
             ref_price = COALESCE(?, ref_price), note = COALESCE(NULLIF(?, ''), note), updated_at = datetime('now', 'localtime') WHERE id = ?`,
          ).run(f.name, f.barcode, f.spec, f.category, f.ref_price, f.note, id);
          updated++;
        } else {
          id = Number(
            db
              .prepare('INSERT INTO products (name, barcode, spec, category, ref_price, note) VALUES (?, ?, ?, ?, ?, ?)')
              .run(f.name, f.barcode, f.spec, f.category, f.ref_price, f.note).lastInsertRowid,
          );
          created++;
        }
        if (Number.isInteger(row.opening_qty) && row.opening_qty > 0) {
          if (!Number.isInteger(row.opening_cost) || row.opening_cost < 0) throw new BizError(`「${f.name}」填了期初数量但没有期初成本`);
          opening.push({ product_id: id, qty: row.opening_qty, unit_price: row.opening_cost });
        }
      }
    });
    let openingDocId: number | null = null;
    if (opening.length) {
      openingDocId = createDoc(db, req.user.id, { type: 'opening_stock', items: opening, note: 'Excel 导入期初库存' });
    }
    log(db, req.user.id, 'import_products', '', { created, updated, opening: opening.length });
    return { created, updated, opening_doc_id: openingDocId };
  });

  // ---------- 单据 ----------
  app.get('/api/docs', async (req) => {
    const { type = '', status = '', q = '', review = '', sort = 'desc', offset = '0', limit = '30' } = req.query as Record<string, string>;
    const dir = sort === 'asc' ? 'ASC' : 'DESC';
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.trim()) {
      // 按淘宝订单号 / 备注 / 对方搜索
      where.push('(d.source_ref LIKE ? OR d.note LIKE ? OR d.counterparty LIKE ?)');
      const like = `%${q.trim()}%`;
      params.push(like, like, like);
    }
    if (review) {
      where.push('d.review = ?');
      params.push(review);
    }
    if (type) {
      where.push(`d.type IN (${type.split(',').map(() => '?').join(',')})`);
      params.push(...type.split(','));
    }
    if (status) {
      where.push('d.status = ?');
      params.push(status);
    }
    const rows = db
      .prepare(
        `SELECT d.*, u.name AS created_by_name, a.name AS account_name, t.name AS to_account_name,
           (SELECT GROUP_CONCAT(p.name || CASE WHEN d.type = 'stocktake' THEN ' ' || printf('%+d', i.qty) ELSE ' ×' || i.qty END, '、')
              FROM doc_items i JOIN products p ON p.id = i.product_id WHERE i.doc_id = d.id AND NOT (d.type = 'stocktake' AND i.qty = 0)) AS item_summary,
           (SELECT COUNT(*) FROM uploads up WHERE up.doc_id = d.id) AS upload_count
         FROM docs d JOIN users u ON u.id = d.created_by
         LEFT JOIN accounts a ON a.id = d.account_id LEFT JOIN accounts t ON t.id = d.to_account_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY d.doc_date ${dir}, d.id ${dir} LIMIT ? OFFSET ?`,
      )
      .all(...params, Number(limit), Number(offset));
    return { items: rows };
  });

  app.post('/api/docs', async (req) => {
    const id = createDoc(db, req.user.id, req.body as DocInput);
    return { doc: getDoc(db, id) };
  });

  app.get('/api/docs/:id', async (req, reply) => {
    const doc = getDoc(db, Number((req.params as any).id));
    if (!doc) return reply.status(404).send({ error: '单据不存在' });
    return { doc };
  });

  app.post('/api/docs/:id/void', async (req) => {
    const id = Number((req.params as any).id);
    voidDoc(db, req.user.id, id, (req.body as any)?.reason ?? '');
    return { doc: getDoc(db, id) };
  });

  // 退货 / 退款：从原销售单发起；replace_doc_id = 用它替换一张待处理退款
  app.post('/api/docs/:id/return', async (req) => {
    const saleId = Number((req.params as any).id);
    const body = req.body as { items?: any[]; doc_date?: string; note?: string; replace_doc_id?: number };
    const id = createReturn(db, req.user.id, saleId, body, { replaceDocId: body.replace_doc_id });
    return { doc: getDoc(db, id) };
  });

  // 待处理退款：确认只退了钱、货没回来
  app.post('/api/docs/:id/refund-only', async (req) => {
    const id = Number((req.params as any).id);
    taobao.confirmRefundOnly(db, req.user.id, id);
    return { doc: getDoc(db, id) };
  });

  // 只允许改不影响金额的字段：备注、图片、日期、支出 / 收入分类。成本按单据日期算，改日期后重算涉及的商品
  app.patch('/api/docs/:id', async (req) => {
    const id = Number((req.params as any).id);
    const { note, upload_ids, doc_date, category } = req.body as { note?: string; upload_ids?: number[]; doc_date?: string; category?: string };
    const cur = db.prepare('SELECT type, source FROM docs WHERE id = ?').get(id) as { type: string; source: string | null } | undefined;
    if (!cur) throw new BizError('单据不存在');
    if (typeof note === 'string') db.prepare('UPDATE docs SET note = ? WHERE id = ?').run(note, id);
    if (doc_date !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(doc_date)) throw new BizError('日期格式不对');
      if (cur.source === 'taobao') throw new BizError('淘宝导入的单据日期按发货时间，不能改');
      tx(db, () => {
        db.prepare('UPDATE docs SET doc_date = ? WHERE id = ?').run(doc_date, id);
        for (const { product_id } of db.prepare('SELECT DISTINCT product_id FROM doc_items WHERE doc_id = ?').all(id) as { product_id: number }[]) {
          replayProduct(db, product_id);
        }
      });
    }
    if (category !== undefined) {
      const cats = cur.type === 'expense' ? EXPENSE_CATEGORIES : cur.type === 'income' ? INCOME_CATEGORIES : null;
      if (!cats || !cats.includes(category)) throw new BizError('这类单据不能改分类，或分类不存在');
      db.prepare('UPDATE docs SET category = ? WHERE id = ?').run(category, id);
    }
    for (const uid of upload_ids ?? []) db.prepare('UPDATE uploads SET doc_id = ? WHERE id = ? AND doc_id IS NULL').run(id, uid);
    log(db, req.user.id, 'edit_doc', `doc:${id}`, { note, upload_ids, doc_date, category });
    return { doc: getDoc(db, id) };
  });

  // ---------- 图片 ----------
  app.post('/api/uploads', async (req) => {
    const parts = req.parts();
    const fields: Record<string, string> = {};
    const files: Record<string, Buffer> = {};
    for await (const part of parts) {
      if (part.type === 'file') files[part.fieldname] = await part.toBuffer();
      else fields[part.fieldname] = String(part.value);
    }
    if (!files.file) throw new BizError('没有收到图片');
    const kind = UPLOAD_KINDS.includes(fields.kind) ? fields.kind : 'other';
    const now = new Date();
    const month = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dir = join(uploadRoot, month);
    mkdirSync(dir, { recursive: true });
    const base = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const path = `${month}/${base}.jpg`;
    writeFileSync(join(uploadRoot, path), files.file);
    let origPath: string | null = null;
    if (files.original) {
      origPath = `${month}/${base}-orig.jpg`;
      writeFileSync(join(uploadRoot, origPath), files.original);
    }
    const r = db
      .prepare('INSERT INTO uploads (kind, path, orig_path, note, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(kind, path, origPath, fields.note ?? '', req.user.id);
    return { upload: db.prepare('SELECT * FROM uploads WHERE id = ?').get(Number(r.lastInsertRowid)) };
  });

  app.get('/api/uploads', async (req) => {
    const { kind = '', user = '', from = '', to = '', offset = '0', limit = '40' } = req.query as Record<string, string>;
    const where = ['1 = 1'];
    const params: (string | number)[] = [];
    if (kind) (where.push('up.kind = ?'), params.push(kind));
    if (user) (where.push('up.created_by = ?'), params.push(Number(user)));
    if (from) (where.push('date(up.created_at) >= ?'), params.push(from));
    if (to) (where.push('date(up.created_at) <= ?'), params.push(to));
    const rows = db
      .prepare(
        `SELECT up.*, u.name AS created_by_name, d.type AS doc_type, d.category AS doc_category, d.amount AS doc_amount,
                d.status AS doc_status, d.note AS doc_note, d.doc_date
         FROM uploads up JOIN users u ON u.id = up.created_by LEFT JOIN docs d ON d.id = up.doc_id
         WHERE ${where.join(' AND ')} AND up.kind != 'product'
         ORDER BY up.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, Number(limit), Number(offset));
    return { items: rows };
  });

  app.patch('/api/uploads/:id', async (req) => {
    const id = Number((req.params as any).id);
    db.prepare('UPDATE uploads SET note = ? WHERE id = ?').run(String((req.body as any)?.note ?? ''), id);
    return { upload: db.prepare('SELECT * FROM uploads WHERE id = ?').get(id) };
  });

  app.get('/files/:id', async (req, reply) => {
    const up = db.prepare('SELECT * FROM uploads WHERE id = ?').get(Number((req.params as any).id)) as any;
    if (!up) return reply.status(404).send({ error: '图片不存在' });
    const rel = (req.query as any).orig && up.orig_path ? up.orig_path : up.path;
    const file = resolve(uploadRoot, rel);
    if (!existsSync(file)) return reply.status(404).send({ error: '图片文件丢失' });
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.type('image/jpeg').send(createReadStream(file));
  });

  // ---------- 识别 ----------
  app.post('/api/recognize', async (req) => {
    const { upload_id, mode } = req.body as { upload_id: number; mode: RecognizeMode };
    const up = db.prepare('SELECT * FROM uploads WHERE id = ?').get(upload_id) as any;
    if (!up) throw new BizError('图片不存在');
    const result = await recognize(resolve(uploadRoot, up.orig_path ?? up.path), mode === 'sale' ? 'sale' : 'purchase');
    const lines = result.items.map((it) => {
      const m = matchProduct(db, it.name, it.barcode);
      const c = m.product ? null : matchCatalog(db, it.name, it.barcode);
      return {
        catalog: c?.item ?? null,
        catalog_candidates: c?.candidates ?? [],
        raw_name: it.name,
        barcode: it.barcode ?? null,
        qty: it.qty,
        unit_price: Math.round(it.unit_price * 100),
        product: m.product ? withAvg(db.prepare('SELECT * FROM products WHERE id = ?').get(m.product.id)) : null,
        matched_by: m.by,
        candidates: m.candidates,
      };
    });
    log(db, req.user.id, 'recognize', `upload:${upload_id}`, { mode, lines: lines.length });
    return {
      date: result.date ?? null,
      store: result.store ?? null,
      buyer: result.buyer ?? null,
      channel: result.channel ?? null,
      order_no: result.order_no ?? null,
      total: result.total != null ? Math.round(result.total * 100) : null,
      lines,
    };
  });

  // ---------- 淘宝订单 ----------
  /** 上传千牛导出的主订单表 + 子订单表（顺序随意，按表头识别）；dry=1 只试跑 */
  app.post('/api/taobao/import', async (req) => importUpload(req));
  // 插件上传的是同样两张表
  app.post('/api/agent/orders', async (req) => importUpload(req));

  async function importUpload(req: FastifyRequest) {
    const sheets: Record<string, Record<string, string>[]> = {};
    let dry = false;
    let onlyData = false;
    const saved: { name: string; buf: Buffer }[] = [];
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        let rows: Record<string, string>[];
        try {
          rows = readXlsx(buf);
        } catch {
          throw new BizError(`「${part.filename}」不是有效的 xlsx 文件`);
        }
        const kind = taobao.detectSheet(rows);
        if (!kind) throw new BizError(`认不出「${part.filename}」是主订单表还是子订单表`);
        sheets[kind] = rows;
        saved.push({ name: part.filename, buf });
      } else if (part.fieldname === 'dry') dry = String(part.value) === '1';
      else if (part.fieldname === 'only_data') onlyData = String(part.value) === '1';
    }
    const run = () => taobao.importTaobao(db, req.user.id, sheets.orders ?? [], sheets.items ?? [], { only_data: onlyData });
    const report = dry ? dryRun(db, run) : run();
    if (!dry) {
      // 原始文件留档，方便事后对账
      const dir = join(dataDir, 'imports', 'taobao');
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
      for (const f of saved) writeFileSync(join(dir, `${stamp}-${f.name.replace(/[^\w.-]/g, '_')}`), f.buf);
    }
    return { dry, report };
  }

  // ---------- 淘宝插件 ----------
  app.get('/api/plugin', async () => agent.agentStatus(db));
  app.post('/api/plugin/token', async (req) => ({ token: agent.resetToken(db, req.user.id) }));
  app.post('/api/plugin/tasks', async (req) => {
    const id = agent.createTask(db, req.user.id, String((req.body as any)?.kind ?? ''));
    return { id, ...agent.agentStatus(db) };
  });
  // 插件每分钟来一次：领任务（没有就是 null）
  app.post('/api/agent/next', async () => ({ task: agent.nextTask(db) }));
  app.post('/api/agent/tasks/:id', async (req) => {
    const { ok, message } = (req.body ?? {}) as { ok?: boolean; message?: string };
    agent.finishTask(db, Number((req.params as any).id), !!ok, message ?? '');
    return { ok: true };
  });
  // 插件自己按时发起的任务也记一笔，页面上能看到
  app.post('/api/agent/tasks', async (req) => ({ task: agent.startOwnTask(db, String((req.body as any)?.kind ?? '')) }));
  // 插件出错时的现场（淘宝返回的网页等），存成文件方便排查，只留最近 20 份
  app.post('/api/agent/debug', async (req) => {
    const dir = join(dataDir, 'imports', 'debug');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(req.body ?? {}, null, 2));
    for (const f of readdirSync(dir).sort().slice(0, -20)) rmSync(join(dir, f));
    return { ok: true };
  });
  app.post('/api/agent/skus', async (req) => ({ result: taobao.syncCatalog(db, req.user.id, ((req.body as any)?.items ?? []) as taobao.CatalogInput[]) }));

  app.get('/api/taobao/overview', async () => ({
    status: taobao.taobaoStatus(db),
    receivable: receivable(db),
    skus: taobao.listSkus(db),
    actual: taobao.listActual(db),
    unmatched: taobao.listUnmatched(db),
    pending_refunds: taobao.listPendingRefunds(db),
  }));

  app.put('/api/taobao/sku-map', async (req) => {
    const { item_id, sku, items } = req.body as { item_id: string; sku: string; items: taobao.MapItemInput[] };
    return { result: taobao.setSkuMap(db, req.user.id, item_id, sku ?? '', items ?? []) };
  });

  app.post('/api/taobao/sku-map/confirm-all', async (req) => ({ result: taobao.confirmAllSkus(db, req.user.id) }));

  // 同步待确认：逐单确认新增 / 状态变了的订单扣了哪些库存
  app.get('/api/taobao/reviews', async () => ({ items: taobao.listReviews(db) }));
  app.post('/api/taobao/reviews/confirm-all', async (req) => taobao.confirmAllReviews(db, req.user.id));
  app.post('/api/taobao/reviews/:no/confirm', async (req) => taobao.confirmReview(db, req.user.id, (req.params as any).no as string));

  app.get('/api/taobao/orders', async (req) => {
    const { group = '', q = '', offset = '0' } = req.query as Record<string, string>;
    return taobao.listOrders(db, { group, q, offset: Number(offset) });
  });

  app.get('/api/taobao/orders/:no', async (req, reply) => {
    const r = taobao.getOrder(db, (req.params as any).no as string);
    if (!r) return reply.status(404).send({ error: '订单不存在' });
    return r;
  });

  app.put('/api/taobao/orders/:no/actual', async (req) => {
    const no = (req.params as any).no as string;
    return { result: taobao.setActual(db, req.user.id, no, req.body as any) };
  });

  // ---------- 首页 ----------
  app.get('/api/dashboard', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const isDate = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    // 默认本月 1 号到今天；兼容旧的 ?month=2026-09（整月）
    let from = `${today.slice(0, 8)}01`;
    let to = today;
    if (q.month && /^\d{4}-\d{2}$/.test(q.month)) {
      from = `${q.month}-01`;
      to = `${q.month}-31`;
    }
    if (isDate(q.from)) from = q.from!;
    if (isDate(q.to)) to = q.to!;
    if (from > to) [from, to] = [to, from];
    return {
      from,
      to,
      accounts: accountBalances(db),
      settle: settleSuggestions(db),
      capital: capital(db),
      month_profit: profit(db, { from, to }),
      total_profit: profit(db),
      inventory: inventorySummary(db),
      receivable: (({ items: _items, ...r }) => r)(receivable(db)),
      taobao: taobao.taobaoStatus(db),
    };
  });

  app.get('/api/settle', async () => ({ items: settleSuggestions(db) }));

  app.get('/api/logs', async (req) => {
    const { offset = '0' } = req.query as Record<string, string>;
    return {
      items: db
        .prepare(`SELECT l.*, u.name AS user_name FROM logs l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 50 OFFSET ?`)
        .all(Number(offset)),
    };
  });

  // ---------- 备份 ----------
  app.get('/api/backups', async () => ({ items: listBackups(dataDir) }));
  app.post('/api/backups', async (req) => {
    const file = createBackup(db, dataDir);
    log(db, req.user.id, 'backup');
    return { file: file.split('/').pop() };
  });
  app.get('/api/backups/:name', async (req, reply) => {
    const name = (req.params as any).name as string;
    if (!listBackups(dataDir).includes(name)) return reply.status(404).send({ error: '备份不存在' });
    reply.header('Content-Disposition', `attachment; filename="${name}"`);
    return reply.type('application/gzip').send(createReadStream(join(dataDir, 'backups', name)));
  });

  // ---------- 前端静态文件 ----------
  if (opts.webDir && existsSync(opts.webDir)) {
    // wildcard 模式按请求实时查文件，重新打包后不用重启；找不到的路径交给 SPA 兜底
    app.register(fastifyStatic, {
      root: resolve(opts.webDir),
      setHeaders: (res, path) => {
        // 带 hash 的资源长缓存，入口页不缓存
        res.header('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/assets/')) return reply.status(404).send({ error: 'Not found' });
      // 入口页不缓存，保证重新打包后拿到新的资源文件名
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    });
  }

  return { app, db };
}

declare module 'fastify' {
  interface FastifyInstance {
    db: DB;
  }
}
