import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.ts';
import type { Recognized } from '../src/vision.ts';
import { parseSpec } from '../src/aldi.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'kucun-test-'));
let fakeRecognized: Recognized = { items: [] };
const { app, db } = buildApp({ dataDir, recognize: async () => fakeRecognized });
let cookie = '';

async function api(method: string, url: string, body?: unknown) {
  const res = await app.inject({ method: method as any, url, payload: body as any, headers: { cookie } });
  const json = res.json();
  if (res.statusCode >= 400) throw Object.assign(new Error(json.error), { status: res.statusCode });
  return json;
}

let acc: Record<string, number> = {};
const product = async (name: string, barcode?: string) => (await api('POST', '/api/products', { name, barcode })).product.id as number;
const stock = async (id: number) => (await api('GET', `/api/products/${id}`)).product;
const balances = async () => {
  const { accounts } = await api('GET', '/api/meta');
  return Object.fromEntries(accounts.map((a: any) => [a.name, a.balance]));
};

before(async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'lq', password: '123qweasd' } });
  assert.equal(res.statusCode, 200);
  cookie = `sid=${res.cookies.find((c) => c.name === 'sid')!.value}`;
  const { accounts } = await api('GET', '/api/meta');
  acc = Object.fromEntries(accounts.map((a: any) => [a.name, a.id]));
});

after(() => rmSync(dataDir, { recursive: true, force: true }));

test('未登录访问被拒绝，错误密码登录失败', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/meta' });
  assert.equal(r.statusCode, 401);
  const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'lq', password: 'x' } });
  assert.equal(bad.statusCode, 400);
});

test('四个账号 + 公共资金账户已建好，显示中文名', async () => {
  const { accounts, users } = await api('GET', '/api/meta');
  assert.deepEqual(users.map((u: any) => u.username), ['lq', 'lc', 'yhh', 'xrf']);
  assert.deepEqual(users.map((u: any) => u.name), ['卢琼', '卢程', '虞慧慧', '许荣飞']);
  assert.equal(accounts.length, 5);
});

test('不同进价按移动加权平均结转成本', async () => {
  const p = await product('坚果礼盒', '6901234567890');
  await api('POST', '/api/docs', { type: 'purchase', account_id: acc['公共资金'], items: [{ product_id: p, qty: 2, unit_price: 1000 }] });
  await api('POST', '/api/docs', { type: 'purchase', account_id: acc['公共资金'], items: [{ product_id: p, qty: 2, unit_price: 1600 }] });
  assert.equal((await stock(p)).avg_cost, 1300);
  const { doc } = await api('POST', '/api/docs', { type: 'sale', account_id: acc['公共资金'], items: [{ product_id: p, qty: 1, unit_price: 2000 }] });
  assert.equal(doc.items[0].cost_amount, 1300);
  const s = await stock(p);
  assert.equal(s.stock_qty, 3);
  assert.equal(s.stock_value, 3900);
});

test('先卖后买：负库存，进货后补上成本', async () => {
  const p = await product('维生素');
  const { doc: sale } = await api('POST', '/api/docs', {
    type: 'sale',
    account_id: acc['卢程'],
    items: [{ product_id: p, qty: 3, unit_price: 5000 }],
  });
  assert.equal(sale.items[0].cost_pending, 3);
  assert.equal((await stock(p)).stock_qty, -3);

  await api('POST', '/api/docs', { type: 'purchase', account_id: acc['卢程'], items: [{ product_id: p, qty: 5, unit_price: 3000 }] });
  const s = await stock(p);
  assert.equal(s.stock_qty, 2);
  assert.equal(s.stock_value, 6000);
  const again = (await api('GET', `/api/docs/${sale.id}`)).doc;
  assert.equal(again.items[0].cost_pending, 0);
  assert.equal(again.items[0].cost_amount, 9000);
});

test('进货按总价录入：均价除不尽时成本和付款都按总价，分钱不丢', async () => {
  const p = await product('隔离霜');
  const before = (await balances())['卢琼'];
  const { doc } = await api('POST', '/api/docs', { type: 'purchase', account_id: acc['卢琼'], items: [{ product_id: p, qty: 17, amount: 100000 }] });
  assert.equal(doc.amount, 100000);
  assert.equal(doc.items[0].amount, 100000);
  assert.equal(doc.items[0].unit_price, 5882); // 1000 ÷ 17 ≈ 58.82
  assert.equal((await balances())['卢琼'] - before, -100000);
  let s = await stock(p);
  assert.equal(s.stock_qty, 17);
  assert.equal(s.stock_value, 100000);
  // 全部卖完，成本合计正好等于进货总价
  const { doc: a } = await api('POST', '/api/docs', { type: 'sale', account_id: acc['公共资金'], items: [{ product_id: p, qty: 5, unit_price: 9900 }] });
  const { doc: b } = await api('POST', '/api/docs', { type: 'sale', account_id: acc['公共资金'], items: [{ product_id: p, qty: 12, unit_price: 9900 }] });
  assert.equal(a.items[0].cost_amount + b.items[0].cost_amount, 100000);
  await assert.rejects(api('POST', '/api/docs', { type: 'purchase', account_id: acc['卢琼'], items: [{ product_id: p, qty: 1, amount: -1 }] }), /总价/);
});

test('进货多项额外费用 / 减免：影响实付和利润，不影响商品均价', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kucun-fee-'));
  const { app: a2 } = buildApp({ dataDir: dir });
  const login = await a2.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'lq', password: '123qweasd' } });
  const ck = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
  const call = async (m: string, url: string, body?: unknown) => (await a2.inject({ method: m as any, url, payload: body as any, headers: { cookie: ck } })).json();
  const { accounts } = await call('GET', '/api/meta');
  const pub = accounts.find((x: any) => x.kind === 'public').id;
  const pid = (await call('POST', '/api/products', { name: '牙膏' })).product.id;
  const { doc } = await call('POST', '/api/docs', {
    type: 'purchase', account_id: pub, items: [{ product_id: pid, qty: 2, amount: 1180 }],
    adjustments: [{ name: '运费', amount: 600 }, { name: '包装费', amount: 200 }, { name: '优惠券', amount: -300 }],
  });
  assert.equal(doc.amount, 1180 + 800 - 300);
  assert.deepEqual(doc.adjustments.map((a: any) => [a.name, a.amount]), [['运费', 600], ['包装费', 200], ['优惠券', -300]]);
  assert.equal(doc.items[0].unit_price, 590); // 标价均价
  // 进价 = 实付：运费、包装费、优惠券都摊进商品成本
  const p = (await call('GET', `/api/products/${pid}`)).product;
  assert.equal(p.avg_cost, 840);
  assert.equal(p.stock_value, 1680);
  const d = await call('GET', '/api/dashboard');
  assert.equal(d.accounts.find((x: any) => x.kind === 'public').balance, -1680);
  assert.equal(d.total_profit.expenses, 0);
  assert.equal(d.total_profit.other_income, 0);
  assert.equal(d.total_profit.net, 0);
  // 卖出 1 件：成本按实付均价 840
  const sale = (await call('POST', '/api/docs', { type: 'sale', account_id: pub, items: [{ product_id: pid, qty: 1, unit_price: 1000 }] })).doc;
  assert.equal(sale.items[0].cost_amount, 840);
  // 库存价值 840 + 利润 160 = 付出 1680 − 收回 1000，账对得上
  assert.equal((await call('GET', '/api/dashboard')).total_profit.net, 160);
  await call('POST', `/api/docs/${sale.id}/void`, { reason: 'x' });
  const bad = await a2.inject({ method: 'POST', url: '/api/docs', headers: { cookie: ck }, payload: { type: 'purchase', account_id: pub, items: [{ product_id: pid, qty: 1, amount: 100 }], adjustments: [{ name: '满减', amount: -101 }] } });
  assert.match(bad.json().error, /减免不能超过/);
  await call('POST', `/api/docs/${doc.id}/void`, { reason: 'x' });
  const d2 = await call('GET', '/api/dashboard');
  assert.equal(d2.total_profit.net, 0);
  assert.equal(d2.accounts.find((x: any) => x.kind === 'public').balance, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('先卖后买 + 按总价进货：补上的成本按件数分摊总价', async () => {
  const p = await product('唇膏');
  const { doc: sale } = await api('POST', '/api/docs', { type: 'sale', account_id: acc['公共资金'], items: [{ product_id: p, qty: 1, unit_price: 5000 }] });
  await api('POST', '/api/docs', { type: 'purchase', account_id: acc['公共资金'], items: [{ product_id: p, qty: 3, amount: 1000 }] });
  assert.equal((await api('GET', `/api/docs/${sale.id}`)).doc.items[0].cost_amount, 333);
  const s = await stock(p);
  assert.equal(s.stock_qty, 2);
  assert.equal(s.stock_value, 667);
});

test('作废进货单后库存和成本回滚', async () => {
  const p = await product('面膜');
  const { doc: a } = await api('POST', '/api/docs', { type: 'purchase', account_id: acc['公共资金'], items: [{ product_id: p, qty: 1, unit_price: 100 }] });
  await api('POST', '/api/docs', { type: 'purchase', account_id: acc['公共资金'], items: [{ product_id: p, qty: 1, unit_price: 300 }] });
  const { doc: sale } = await api('POST', '/api/docs', { type: 'sale', account_id: acc['公共资金'], items: [{ product_id: p, qty: 1, unit_price: 500 }] });
  assert.equal(sale.items[0].cost_amount, 200);

  await assert.rejects(api('POST', `/api/docs/${a.id}/void`, { reason: '' }), /作废原因/);
  await api('POST', `/api/docs/${a.id}/void`, { reason: '录重了' });
  const s = await stock(p);
  assert.equal(s.stock_qty, 0);
  assert.equal((await api('GET', `/api/docs/${sale.id}`)).doc.items[0].cost_amount, 300);
  await assert.rejects(api('POST', `/api/docs/${a.id}/void`, { reason: 'x' }), /已作废/);
});

test('盘点：少了计损耗，多了补回', async () => {
  const p = await product('洗发水');
  await api('POST', '/api/docs', { type: 'purchase', account_id: acc['公共资金'], items: [{ product_id: p, qty: 5, unit_price: 2000 }] });
  const { doc } = await api('POST', '/api/docs', { type: 'stocktake', items: [{ product_id: p, counted_qty: 3 }] });
  assert.equal(doc.items[0].qty, -2);
  assert.equal(doc.items[0].cost_amount, 4000);
  assert.equal((await stock(p)).stock_qty, 3);
  const { doc: gain } = await api('POST', '/api/docs', { type: 'stocktake', items: [{ product_id: p, counted_qty: 4 }] });
  assert.equal(gain.items[0].qty, 1);
  assert.equal(gain.items[0].cost_amount, 2000);
});

test('账户余额、报销建议与转账', async () => {
  const before = await balances();
  await api('POST', '/api/docs', { type: 'expense', category: '快递运费', account_id: acc['许荣飞'], amount: 1200, note: '寄顺丰' });
  let b = await balances();
  assert.equal(b['许荣飞'] - before['许荣飞'], -1200);

  const { items } = await api('GET', '/api/settle');
  const s = items.find((x: any) => x.to_name === '许荣飞');
  assert.equal(s.amount, 1200);
  await api('POST', '/api/docs', { type: 'transfer', account_id: s.from_account_id, to_account_id: s.to_account_id, amount: s.amount });
  b = await balances();
  assert.equal(b['许荣飞'], 0);
  await assert.rejects(api('POST', '/api/docs', { type: 'transfer', account_id: acc['许荣飞'], to_account_id: acc['许荣飞'], amount: 1 }), /同一个账户/);
});

test('利润：销售额 - 成本 - 费用 - 损耗 + 其他收入，按 lq/yhh 平分', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kucun-profit-'));
  const { app: a2 } = buildApp({ dataDir: dir });
  const login = await a2.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'yhh', password: '123qweasd' } });
  const ck = `sid=${login.cookies.find((c) => c.name === 'sid')!.value}`;
  const call = async (m: string, url: string, body?: unknown) => (await a2.inject({ method: m as any, url, payload: body as any, headers: { cookie: ck } })).json();
  const { accounts } = await call('GET', '/api/meta');
  const pub = accounts.find((x: any) => x.kind === 'public').id;
  await call('POST', '/api/docs', { type: 'opening_balance', account_id: pub, amount: 100000 });
  const pid = (await call('POST', '/api/products', { name: 'A' })).product.id;
  await call('POST', '/api/docs', { type: 'purchase', account_id: pub, items: [{ product_id: pid, qty: 10, unit_price: 1000 }] });
  const sale = (await call('POST', '/api/docs', { type: 'sale', account_id: pub, items: [{ product_id: pid, qty: 4, unit_price: 2500 }] })).doc;
  await call('POST', '/api/docs', { type: 'outbound', category: '损耗', items: [{ product_id: pid, qty: 1 }] });
  await call('POST', '/api/docs', { type: 'expense', category: '包装耗材', account_id: pub, amount: 500 });
  await call('POST', '/api/docs', { type: 'income', category: '其他收入', account_id: pub, amount: 200 });
  // 退 1 件：退款 1000，货退回按原成本 1000 入库
  await call('POST', `/api/docs/${sale.id}/return`, { items: [{ ref_item_id: sale.items[0].id, qty: 1, amount: 1000 }] });

  const d = await call('GET', '/api/dashboard');
  const t = d.total_profit;
  assert.equal(t.revenue, 9000);
  assert.equal(t.cogs, 3000);
  assert.equal(t.outbound_cost, 1000);
  assert.equal(t.net, 9000 - 3000 - 500 - 1000 + 200);
  assert.deepEqual(t.shares.map((s: any) => [s.name, s.amount]), [['卢琼', 2350], ['虞慧慧', 2350]]);
  assert.equal(d.capital, 100000);
  assert.equal(d.accounts.find((x: any) => x.kind === 'public').balance, 100000 - 10000 + 10000 - 500 + 200 - 1000);
  assert.equal(d.inventory.value, 6000);
  rmSync(dir, { recursive: true, force: true });
});

test('Excel 导入：重复条码更新，期初库存不动钱', async () => {
  const before = await balances();
  const r = await api('POST', '/api/products/import', {
    rows: [
      { name: '坚果礼盒(新名)', barcode: '6901234567890', spec: '500g' },
      { name: '牙膏', barcode: '6900000000001', opening_qty: 4, opening_cost: 800 },
    ],
  });
  assert.equal(r.created, 1);
  assert.equal(r.updated, 1);
  const found = (await api('GET', '/api/products/barcode/6900000000001')).product;
  assert.equal(found.stock_qty, 4);
  assert.deepEqual(await balances(), before);
  await assert.rejects(api('POST', '/api/products', { name: 'dup', barcode: '6900000000001' }), /条码已被/);
});

test('识别结果按条码 / 别名 / 名称匹配，并记住别名', async () => {
  const p = await product('Kirkland 混合坚果 1.13kg');
  fakeRecognized = {
    store: '山姆',
    items: [
      { name: 'KS MIXED NUTS', qty: 2, unit_price: 99.9 },
      { name: '牙膏', barcode: '6900000000001', qty: 1, unit_price: 9.5 },
    ],
  };
  const up = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { cookie, 'content-type': 'multipart/form-data; boundary=X' },
    payload: '--X\r\nContent-Disposition: form-data; name="kind"\r\n\r\nreceipt\r\n--X\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\nfakejpeg\r\n--X--\r\n',
  });
  const uploadId = up.json().upload.id;
  let r = await api('POST', '/api/recognize', { upload_id: uploadId, mode: 'purchase' });
  assert.equal(r.lines[0].product, null);
  assert.equal(r.lines[0].unit_price, 9990);
  assert.equal(r.lines[1].matched_by, 'barcode');

  await api('POST', '/api/docs', {
    type: 'purchase',
    account_id: acc['公共资金'],
    upload_ids: [uploadId],
    items: [{ product_id: p, qty: 2, unit_price: 9990, raw_name: 'KS MIXED NUTS' }],
  });
  r = await api('POST', '/api/recognize', { upload_id: uploadId, mode: 'purchase' });
  assert.equal(r.lines[0].matched_by, 'alias');
  assert.equal(r.lines[0].product.id, p);

  const album = await api('GET', '/api/uploads?kind=receipt');
  assert.equal(album.items[0].doc_type, 'purchase');
});

test('简称也能搜到商品，并出现在识别候选里', async () => {
  const p = await product('KS 维生素C 500粒');
  const { items } = await api('GET', `/api/products?q=${encodeURIComponent('维C')}`);
  assert.ok(items.some((x: any) => x.id === p));
  fakeRecognized = { items: [{ name: '维C', qty: 1, unit_price: 159 }] };
  const up = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { cookie, 'content-type': 'multipart/form-data; boundary=X' },
    payload: '--X\r\nContent-Disposition: form-data; name="kind"\r\n\r\nsale_shot\r\n--X\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\nx\r\n--X--\r\n',
  });
  const r = await api('POST', '/api/recognize', { upload_id: up.json().upload.id, mode: 'sale' });
  assert.equal(r.lines[0].product, null);
  assert.ok(r.lines[0].candidates.some((c: any) => c.id === p));
});

async function uploadFake(kind: string) {
  const up = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { cookie, 'content-type': 'multipart/form-data; boundary=X' },
    payload: `--X\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n--X\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\nx\r\n--X--\r\n`,
  });
  return up.json().upload.id as number;
}

test('奥乐齐参考库：不进商品表，搜索 / 识别 / 扫货号可查，提交单据时自动建档且只建一次', async () => {
  const ins = db.prepare(
    `INSERT INTO catalog_items (source, source_id, name, spec, category, brand, sku_code, image_url, sell) VALUES ('aldi', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ins.run('9001', '超值 手撕猪肉脯150g', '150g', '休闲零食/肉干小食', '超值', '10008423', 'https://img/1.jpg', '精选猪腿肉');
  ins.run('9002', 'Aldi Delight南瓜风吹饼172g', '172g', '休闲零食/饼干曲奇', 'Aldi Delight', '10009205', null, '');

  // 商品列表里没有参考库商品
  const list = await api('GET', '/api/products?q=猪肉脯');
  assert.equal(list.items.length, 0);
  // 参考库能搜到，简称也行
  const found = await api('GET', `/api/catalog?q=${encodeURIComponent('猪肉脯')}`);
  assert.equal(found.items[0].source_id, '9001');
  assert.equal(found.items[0].product_id, null);
  // 扫到货号能认出参考库商品
  const byCode = await api('GET', '/api/products/barcode/10009205');
  assert.equal(byCode.product, null);
  assert.equal(byCode.catalog.name, 'Aldi Delight南瓜风吹饼172g');
  // 类目树合并了参考库
  const cats = await api('GET', '/api/products/categories');
  assert.ok(cats.items.find((c: any) => c.name === '休闲零食')?.children.some((x: any) => x.name === '肉干小食'));

  // 小票识别：商品表匹配不上时给出参考库匹配
  fakeRecognized = { items: [{ name: '超值手撕猪肉脯 150G', qty: 2, unit_price: 10.5 }] };
  const r = await api('POST', '/api/recognize', { upload_id: await uploadFake('receipt'), mode: 'purchase' });
  assert.equal(r.lines[0].product, null);
  const catalogId = r.lines[0].catalog.id;
  assert.equal(r.lines[0].catalog.source_id, '9001');

  // 进货单直接引用参考库商品 → 自动建档
  const { doc } = await api('POST', '/api/docs', {
    type: 'purchase',
    account_id: acc['公共资金'],
    items: [{ catalog_id: catalogId, qty: 2, unit_price: 1050, raw_name: '超值手撕猪肉脯 150G', barcode: '6970000000017' }],
  });
  const pid = doc.items[0].product_id;
  const p = (await api('GET', `/api/products/${pid}`)).product;
  assert.equal(p.name, '超值 手撕猪肉脯150g');
  assert.equal(p.sku_code, '10008423');
  assert.equal(p.category, '休闲零食/肉干小食');
  assert.equal(p.barcode, '6970000000017');
  assert.equal(p.stock_qty, 2);

  // 再次引用同一个参考库商品不会重复建档；下次识别直接命中商品（别名）
  const again = await api('POST', '/api/products', { catalog_id: catalogId });
  assert.equal(again.product.id, pid);
  const r2 = await api('POST', '/api/recognize', { upload_id: await uploadFake('receipt'), mode: 'purchase' });
  assert.equal(r2.lines[0].product.id, pid);
  assert.equal((await api('GET', `/api/catalog?q=${encodeURIComponent('猪肉脯')}`)).items[0].product_id, pid);
});

test('销售渠道默认淘宝在第一位', async () => {
  const { sale_channels } = await api('GET', '/api/meta');
  assert.equal(sale_channels[0], '淘宝');
});

test('从商品名解析规格', () => {
  assert.equal(parseSpec('超值 手撕猪肉脯150g'), '150g');
  assert.equal(parseSpec('寻露 饮用纯净水 550毫升*12'), '550毫升*12');
  assert.equal(parseSpec('Kirkland 混合坚果 1.13kg'), '1.13kg');
  assert.equal(parseSpec('ALDI HOME 竹洁周抛抹布'), '');
});

test('淘宝长标题也能匹配到商品', async () => {
  const p = await product('Aldi Delight南瓜风吹饼172g');
  fakeRecognized = { items: [{ name: 'ALDI奥乐齐 南瓜风吹饼 172g 酥脆饼干 上海现货', qty: 1, unit_price: 15.9 }] };
  const r = await api('POST', '/api/recognize', { upload_id: await uploadFake('sale_shot'), mode: 'sale' });
  assert.equal(r.lines[0].product?.id, p);
});

test('识别结果前面多了一段 JSON 也能解析', async () => {
  const { parseRecognized } = await import('../src/vision.ts');
  const r = parseRecognized('{"type": "json_object"}\n{"total": 53.5, "items": [{"name": "a {x}", "qty": 2, "unit_price": 18.8}]}');
  assert.equal(r.items[0].qty, 2);
  assert.equal(r.items[0].name, 'a {x}');
  assert.equal(r.total, 53.5);
});
