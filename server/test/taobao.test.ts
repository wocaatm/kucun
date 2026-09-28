import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { buildApp } from '../src/app.ts';
import { readXlsx } from '../src/xlsx.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'kucun-tb-'));
const { app } = buildApp({ dataDir });
let cookie = '';

async function api(method: string, url: string, body?: unknown) {
  const res = await app.inject({ method: method as any, url, payload: body as any, headers: { cookie } });
  const json = res.json();
  if (res.statusCode >= 400) throw Object.assign(new Error(json.error), { status: res.statusCode });
  return json;
}

// ---------- 造 xlsx：stored zip + inlineStr，和千牛导出的格式一致 ----------
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function xlsx(rows: Record<string, string>[]): Buffer {
  const keys = Object.keys(rows[0]);
  const col = (i: number) => String.fromCharCode(65 + (i % 26)).padStart(i >= 26 ? 2 : 1, 'A');
  const row = (vals: string[], r: number) =>
    `<row r="${r}">${vals.map((v, i) => `<c r="${col(i)}${r}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`;
  const sheet = `<worksheet><sheetData>${row(keys, 1)}${rows.map((x, i) => row(keys.map((k) => x[k] ?? ''), i + 2)).join('')}</sheetData></worksheet>`;
  return zip({ 'xl/worksheets/sheet1.xml': sheet, 'xl/sharedStrings.xml': '<sst/>' });
}

// ---------- 淘宝订单构造 ----------
interface Sub {
  sub: string;
  item: string;
  sku: string;
  qty: number;
  paid: string;
  refund?: string;
}
interface Order {
  no: string;
  status: string;
  paid: string;
  postage?: string;
  shipped?: string;
  confirmed?: string;
  remark?: string;
  subs: Sub[];
}

const orderRows = (orders: Order[]) =>
  orders.map((o) => ({
    订单编号: o.no,
    订单状态: o.status,
    买家实付金额: o.paid,
    买家应付邮费: o.postage ?? '0.00',
    确认收货打款金额: o.status === '交易成功' ? o.paid : '0.00',
    退款金额: '0.00',
    订单创建时间: '2026-09-20 10:00:00',
    订单付款时间: '2026-09-20 10:01:00',
    发货时间: o.shipped ?? '',
    确认收货时间: o.confirmed ?? '',
    商家备注: o.remark ?? '',
    订单关闭原因: '订单未关闭',
    收货地址: '上海 上海市 ***',
  }));

const itemRows = (orders: Order[]) =>
  orders.flatMap((o) =>
    o.subs.map((s) => ({
      子订单编号: s.sub,
      主订单编号: o.no,
      商品标题: `奥乐齐 ${s.sku}`,
      商品价格: '99.00',
      购买数量: String(s.qty),
      商品属性: `商品规格:${s.sku}`,
      订单状态: o.status,
      买家实付金额: s.paid,
      退款状态: s.refund ? '退款成功' : '没有申请退款',
      退款金额: s.refund ?? '无退款申请',
      商品ID: s.item,
      发货时间: o.shipped ?? '',
    })),
  );

async function importOrders(orders: Order[], dry = false, auth?: { url: string; headers: Record<string, string> }) {
  const boundary = '----kucuntest';
  const part = (name: string, filename: string, buf: Buffer) =>
    Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      buf,
      Buffer.from('\r\n'),
    ]);
  const payload = Buffer.concat([
    // 故意把子订单表放前面：按表头识别，和顺序无关
    part('b', 'items.xlsx', xlsx(itemRows(orders))),
    part('a', 'orders.xlsx', xlsx(orderRows(orders))),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="dry"\r\n\r\n${dry ? '1' : '0'}\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: 'POST',
    url: auth?.url ?? '/api/taobao/import',
    payload,
    headers: { ...(auth?.headers ?? { cookie }), 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
  const json = res.json();
  if (res.statusCode >= 400) throw new Error(json.error);
  return json.report;
}

let pub = 0;
let A = 0; // 隔离霜
let B = 0; // 护手霜
let C = 0; // 发光水
const stock = async (id: number) => (await api('GET', `/api/products/${id}`)).product.stock_qty as number;
const pubBalance = async () => (await api('GET', '/api/meta')).accounts.find((a: any) => a.kind === 'public').balance as number;

before(async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'lc', password: '123qweasd' } });
  cookie = `sid=${res.cookies.find((c) => c.name === 'sid')!.value}`;
  pub = (await api('GET', '/api/meta')).accounts.find((a: any) => a.kind === 'public').id;
  A = (await api('POST', '/api/products', { name: 'LACURA 柔光焕采隔离霜 40ml' })).product.id;
  B = (await api('POST', '/api/products', { name: 'LACURA 乳木果经典护手霜 75g' })).product.id;
  C = (await api('POST', '/api/products', { name: 'LACURA 熊果苷发光水 200ml' })).product.id;
  await api('POST', '/api/docs', {
    type: 'purchase',
    account_id: pub,
    items: [
      { product_id: A, qty: 10, unit_price: 2000 },
      { product_id: B, qty: 10, unit_price: 1000 },
      { product_id: C, qty: 10, unit_price: 3000 },
    ],
  });
});

after(() => rmSync(dataDir, { recursive: true, force: true }));

test('xlsx 读取：inlineStr 与 sharedStrings、空单元格、转义', () => {
  const rows = readXlsx(xlsx([{ 订单编号: '123', 备注: 'a&b<c' }, { 订单编号: '456', 备注: '' }]));
  assert.deepEqual(rows, [
    { 订单编号: '123', 备注: 'a&b<c' },
    { 订单编号: '456', 备注: '' },
  ]);
  const shared = zip({
    'xl/sharedStrings.xml': '<sst><si><t>表头</t></si><si><r><t>富</t></r><r><t>文本</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>3.5</v></c></row></sheetData></worksheet>',
  });
  assert.deepEqual(readXlsx(shared), [{ 表头: '富文本' }]);
});

test('退货：仅退款不动库存，退货按原成本入库，利润少 = 退款 − 退回成本；不能超退', async () => {
  const sale = (
    await api('POST', '/api/docs', { type: 'sale', account_id: pub, items: [{ product_id: C, qty: 3, unit_price: 5000 }] })
  ).doc;
  const p0 = (await api('GET', '/api/dashboard')).total_profit;
  assert.equal(await stock(C), 7);

  // 仅退款 1000
  await api('POST', `/api/docs/${sale.id}/return`, { items: [{ ref_item_id: sale.items[0].id, qty: 0, amount: 1000 }] });
  assert.equal(await stock(C), 7);
  // 退 1 件货、退款 5000，成本默认按原卖出成本 3000
  const r2 = (await api('POST', `/api/docs/${sale.id}/return`, { items: [{ ref_item_id: sale.items[0].id, qty: 1, amount: 5000 }] })).doc;
  assert.equal(r2.items[0].cost_amount, 3000);
  assert.equal(await stock(C), 8);
  const p1 = (await api('GET', '/api/dashboard')).total_profit;
  assert.equal(p0.net - p1.net, 1000 + (5000 - 3000));

  const detail = (await api('GET', `/api/docs/${sale.id}`)).doc;
  assert.equal(detail.items[0].returned_qty, 1);
  assert.equal(detail.items[0].refunded, 6000);
  assert.equal(detail.returns.length, 2);

  await assert.rejects(api('POST', `/api/docs/${sale.id}/return`, { items: [{ ref_item_id: sale.items[0].id, qty: 3, amount: 0 }] }), /超过/);
  await assert.rejects(api('POST', `/api/docs/${sale.id}/return`, { items: [{ ref_item_id: sale.items[0].id, qty: 0, amount: 9001 }] }), /累计退款/);
  await assert.rejects(api('POST', `/api/docs/${sale.id}/void`, { reason: 'x' }), /先作废退货单/);
  await assert.rejects(api('POST', '/api/docs', { type: 'sale', account_id: pub, amount: -100 }), /至少添加一个商品/);

  // 作废退货单：库存和利润回到原样
  for (const r of detail.returns) await api('POST', `/api/docs/${r.id}/void`, { reason: '测试' });
  await api('POST', `/api/docs/${sale.id}/void`, { reason: '测试' });
  assert.equal(await stock(C), 10);
});

const O1: Order = {
  no: 'T1',
  status: '卖家已发货，等待买家确认',
  paid: '65.00',
  postage: '5.00',
  shipped: '2026-09-21 09:00:00',
  subs: [
    { sub: 'T1-1', item: '100', sku: 'LACURA隔离霜40g', qty: 2, paid: '40.00' },
    { sub: 'T1-2', item: '200', sku: '乳果木经典护手霜75g 1支', qty: 1, paid: '20.00' },
  ],
};
const O2: Order = {
  no: 'T2',
  status: '交易成功',
  paid: '20.00',
  shipped: '2026-09-20 09:00:00',
  confirmed: '2026-09-25 09:00:00',
  subs: [{ sub: 'T2-1', item: '200', sku: '乳果木经典护手霜75g 1支', qty: 1, paid: '20.00' }],
};
const O3: Order = { no: 'T3', status: '买家已付款,等待卖家发货', paid: '20.00', subs: [{ sub: 'T3-1', item: '100', sku: 'LACURA隔离霜40g', qty: 1, paid: '20.00' }] };
const O4: Order = { no: 'T4', status: '交易关闭', paid: '0.00', subs: [{ sub: 'T4-1', item: '100', sku: 'LACURA隔离霜40g', qty: 1, paid: '' }] };
const O5: Order = {
  no: 'T5',
  status: '卖家已发货，等待买家确认',
  paid: '25.00',
  shipped: '2026-09-22 09:00:00',
  remark: '实际发一瓶发光水',
  subs: [{ sub: 'T5-1', item: '100', sku: 'LACURA隔离霜40g', qty: 1, paid: '25.00' }],
};
const O6: Order = {
  no: 'T6',
  status: '卖家已发货，等待买家确认',
  paid: '60.00',
  shipped: '2026-09-22 10:00:00',
  subs: [{ sub: 'T6-1', item: '300', sku: '早C晚A套装1套', qty: 1, paid: '60.00' }],
};

test('淘宝导入：发货即记销售和应收；对不上的商品只记金额不扣库存，补全后重建；重复导入不重复', async () => {
  const dry = await importOrders([O1, O2, O3, O4, O5, O6], true);
  assert.equal(dry.orders, 6);
  assert.equal((await api('GET', '/api/taobao/overview')).skus.length, 0); // 试跑不落库

  const r1 = await importOrders([O1, O2, O3, O4, O5, O6]);
  // 4 个已发货订单都记了销售（营业额算上），但商品都没确定：不建商品、不扣库存，标「未匹配 / 待核对实发」
  assert.equal(r1.created_sales.length, 4);
  assert.equal(r1.auto_mapped, 2); // 隔离霜、护手霜；套装不猜
  assert.equal(r1.unmatched_orders, 4);
  assert.equal(r1.unmatched_amount, 6000 + 500 + 2000 + 2500 + 6000); // T1 整单没对上，邮费也先挂起
  assert.equal(r1.to_ship, 1);
  assert.equal(await stock(A), 10);
  assert.equal(await stock(B), 10);
  assert.equal(await stock(C), 10);
  const products = (await api('GET', '/api/products?limit=100')).items.length;
  const d0 = await api('GET', '/api/dashboard');
  // 没对上的订单（连同邮费）先不计入销售额，应收照样是全额
  assert.equal(d0.total_profit.revenue, 0);
  assert.deepEqual(d0.total_profit.pending, { amount: 17000, orders: 4 });
  assert.equal(d0.receivable.amount, 6500 + 2500 + 6000);
  assert.equal(d0.taobao.unmatched_orders, 4);
  const um = (await api('GET', '/api/taobao/overview')).unmatched;
  assert.deepEqual(
    um.find((u: any) => u.source_ref === 'T5').lines.map((l: any) => l.name),
    ['待核对实发：LACURA隔离霜40g ×1'],
  );

  const ov = await api('GET', '/api/taobao/overview');
  const skuA = ov.skus.find((s: any) => s.item_id === '100');
  assert.equal(skuA.state, 'auto');
  assert.equal(skuA.products[0].product_id, A);
  assert.equal(ov.skus.find((s: any) => s.item_id === '300').state, 'none');

  const conf = await api('POST', '/api/taobao/sku-map/confirm-all');
  assert.equal(conf.result.rebuilt_sales.length, 2); // T1、T2 补全；T6 套装还没对照、T5 实发没核对
  // 套装 = 发光水 + 护手霜
  const set = await api('PUT', '/api/taobao/sku-map', {
    item_id: '300',
    sku: '商品规格:早C晚A套装1套',
    items: [{ product_id: C, qty: 1 }, { product_id: B, qty: 1 }],
  });
  assert.equal(set.result.rebuilt_sales.length, 1);
  assert.equal((await api('GET', '/api/products?limit=100')).items.length, products); // 没有自动新建商品

  // T1：隔离霜 2 + 护手霜 1；T2：护手霜 1；T6：发光水 1 + 护手霜 1；T5 等核对实发；T3 未发货；T4 关闭
  assert.equal(await stock(A), 8);
  assert.equal(await stock(B), 7);
  assert.equal(await stock(C), 9);

  const d = await api('GET', '/api/dashboard');
  assert.equal(d.receivable.amount, 6500 + 6000 + 2500);
  assert.equal(d.receivable.count, 3);
  assert.equal(await pubBalance(), -60000 + 2000); // 只有交易成功的 T2 到账（重建后到账状态不丢）
  // 销售额含邮费；T5 实发还没核对，它的 25 元先不计
  assert.equal(d.total_profit.revenue, 6500 + 2000 + 6000);
  assert.deepEqual(d.total_profit.pending, { amount: 2500, orders: 1 });
  assert.equal(d.taobao.unmatched_orders, 1); // 只剩 T5

  const t1 = (await api('GET', '/api/docs?q=T1')).items.find((x: any) => x.source_ref === 'T1' && x.status === 'active');
  const t1doc = (await api('GET', `/api/docs/${t1.id}`)).doc;
  assert.equal(t1doc.doc_date, '2026-09-21');
  assert.deepEqual(t1doc.adjustments.map((a: any) => [a.name, a.amount]), [['邮费', 500]]);
  assert.equal(t1doc.taobao_order.order_no, 'T1');
  await assert.rejects(api('POST', `/api/docs/${t1.id}/void`, { reason: 'x' }), /不能手动作废/);

  // 实发：T5 实际发的是发光水
  await api('PUT', '/api/taobao/orders/T5/actual', { items: [{ product_id: C, qty: 1 }] });
  assert.equal(await stock(A), 8);
  assert.equal(await stock(C), 8);
  const d5 = await api('GET', '/api/dashboard');
  assert.equal(d5.taobao.unmatched_orders, 0);
  assert.equal(d5.total_profit.revenue, 6500 + 2000 + 2500 + 6000); // 核对后计入
  const t5 = await api('GET', '/api/taobao/orders/T5');
  assert.equal(t5.actual.text, 'LACURA 熊果苷发光水 200ml ×1');
  assert.equal(t5.logs.length, 1);

  // 同一份数据再导一次：什么都不新增
  const again = await importOrders([O1, O2, O3, O4, O5, O6]);
  assert.equal(again.created_sales.length, 0);
  assert.equal(again.rebuilt_sales.length, 0);
  assert.equal(again.refunds.length, 0);
  assert.equal(await stock(A), 8);
});

test('淘宝导入：状态推进 → 到账；发货后退款 → 待处理退款，确认退货后库存回来', async () => {
  const before = await api('GET', '/api/dashboard');
  const O1done = { ...O1, status: '交易成功', confirmed: '2026-09-28 09:00:00' };
  const O6refund: Order = { ...O6, status: '交易关闭', subs: [{ ...O6.subs[0], refund: '60.00' }] };
  const r = await importOrders([O1done, O2, O3, O4, O5, O6refund]);
  assert.equal(r.received, 1);
  assert.equal(r.refunds.length, 1);

  const d = await api('GET', '/api/dashboard');
  assert.equal(d.receivable.amount, 2500); // T1 到账；T6 全额退款后应收为 0；只剩 T5
  assert.equal(await pubBalance(), -60000 + 2000 + 6500);
  assert.equal(d.total_profit.revenue, before.total_profit.revenue - 6000);
  assert.equal(d.taobao.pending_refunds, 1);

  // 默认仅退款：库存不动
  assert.equal(await stock(C), 8);
  const ov = await api('GET', '/api/taobao/overview');
  const pending = ov.pending_refunds[0];
  const sale = (await api('GET', `/api/docs/${pending.ref_doc_id}`)).doc;
  // 确认：发光水退回来了，护手霜没回来；替换掉待处理退款
  const lines = sale.items.map((it: any) => ({
    ref_item_id: it.id,
    qty: it.product_id === C ? 1 : 0,
    amount: it.amount,
  }));
  await api('POST', `/api/docs/${sale.id}/return`, { items: lines, replace_doc_id: pending.id });
  assert.equal(await stock(C), 9);
  assert.equal(await stock(B), 7);
  const after = await api('GET', '/api/dashboard');
  assert.equal(after.taobao.pending_refunds, 0);
  assert.equal(after.total_profit.revenue, d.total_profit.revenue);

  // 再导入一次也不会重新生成退款
  const again = await importOrders([O1done, O2, O3, O4, O5, O6refund]);
  assert.equal(again.refunds.length, 0);
});

test('淘宝导入：没对上的商品发货后退款，只退钱；之后补上对照，退款跟着挂到新单', async () => {
  const O7: Order = {
    no: 'T7',
    status: '卖家已发货，等待买家确认',
    paid: '30.00',
    shipped: '2026-09-23 09:00:00',
    subs: [
      { sub: 'T7-1', item: '900', sku: '神秘新品', qty: 1, paid: '10.00' },
      { sub: 'T7-2', item: '200', sku: '乳果木经典护手霜75g 1支', qty: 1, paid: '20.00' },
    ],
  };
  const base = [O1, O2, O3, O4, O5];
  await importOrders([...base, O7]);
  assert.equal(await stock(B), 6); // 护手霜能确定，照扣；新品不动
  const refunded = { ...O7, subs: [{ ...O7.subs[0], refund: '10.00' }, O7.subs[1]] };
  const r = await importOrders([...base, refunded]);
  assert.equal(r.refunds.length, 1);
  const ret = (await api('GET', `/api/docs/${r.refunds[0]}`)).doc;
  assert.equal(ret.amount, 1000);
  assert.equal(ret.items.length, 0);
  assert.deepEqual(ret.adjustments.map((a: any) => a.name), ['退款：神秘新品']);

  await api('PUT', '/api/taobao/sku-map', { item_id: '900', sku: '商品规格:神秘新品', items: [{ product_id: A, qty: 1 }] });
  const sale = (await api('GET', `/api/docs/${(await api('GET', `/api/docs/${r.refunds[0]}`)).doc.ref_doc_id}`)).doc;
  assert.equal(sale.status, 'active');
  assert.equal(sale.review, '');
  assert.equal(sale.returns.length, 1);
  assert.equal(await stock(A), 7);
});

test('改实发：刷单空包不扣库存、销售额照算；改回按下单；待发货可先填；货退回来的订单不能改', async () => {
  const before = await api('GET', '/api/dashboard');
  const bBefore = await stock(B);
  const cash = await pubBalance();
  const lq = (await api('GET', '/api/meta')).accounts.find((a: any) => a.name === '卢琼').id;
  // T2（交易成功，已到账）其实是刷单：空包；卢琼私下给刷手发了 25 元红包
  await api('POST', '/api/docs', { type: 'expense', category: '刷单', account_id: lq, amount: 2500, note: '红包' });
  const r = await api('PUT', '/api/taobao/orders/T2/actual', { items: [] });
  assert.equal(r.result.rebuilt_sales.length, 1);
  assert.equal(await stock(B), bBefore + 1); // 护手霜没真发出去，库存回来
  assert.equal(await pubBalance(), cash); // 淘宝的钱照样到账
  const d = await api('GET', '/api/dashboard');
  assert.equal(d.total_profit.revenue, before.total_profit.revenue); // 销售额照算
  assert.equal(d.total_profit.net, before.total_profit.net - 2500 + 1000); // 红包算支出，省下护手霜成本
  const sale = (await api('GET', `/api/docs/${r.result.rebuilt_sales[0]}`)).doc;
  assert.equal(sale.received, 1);
  assert.equal(sale.items.length, 0);
  assert.deepEqual(sale.adjustments.map((a: any) => [a.name, a.amount]), [['货款：空包', 2000]]);
  assert.equal(d.taobao.unmatched_orders, before.taobao.unmatched_orders);

  // 改回按下单的发
  await api('PUT', '/api/taobao/orders/T2/actual', { as_ordered: true });
  assert.equal(await stock(B), bBefore);
  const t2 = await api('GET', '/api/taobao/orders/T2');
  assert.equal(t2.actual.text, '按下单发');
  assert.deepEqual(t2.logs.map((l: any) => JSON.parse(l.detail).after), ['按下单发', '空包']);
  assert.equal(t2.docs.filter((x: any) => x.status === 'active').length, 1);

  // 待发货的 T3（隔离霜）先填好实发：发光水；发货导入后按实发扣
  const [a0, c0] = [await stock(A), await stock(C)];
  const list = await api('GET', '/api/taobao/orders?group=to_ship');
  assert.deepEqual(list.items.map((o: any) => o.order_no), ['T3']);
  await api('PUT', '/api/taobao/orders/T3/actual', { items: [{ product_id: C, qty: 1 }] });
  assert.equal(await stock(C), c0);
  await importOrders([{ ...O3, status: '卖家已发货，等待买家确认', shipped: '2026-09-24 09:00:00' }]);
  assert.equal(await stock(A), a0);
  assert.equal(await stock(C), c0 - 1);
  assert.equal((await api('GET', '/api/taobao/orders?group=shipped')).items.some((o: any) => o.order_no === 'T3'), true);

  // T6 已确认发光水退回来了：不能改实发
  assert.equal((await api('GET', '/api/taobao/orders/T6')).returned, true);
  await assert.rejects(api('PUT', '/api/taobao/orders/T6/actual', { items: [] }), /退回来/);
});

test('改实发：只退了钱的订单可以改，退款转成不关联商品的金额', async () => {
  const O8: Order = {
    no: 'T8',
    status: '卖家已发货，等待买家确认',
    paid: '20.00',
    shipped: '2026-09-25 09:00:00',
    subs: [{ sub: 'T8-1', item: '200', sku: '乳果木经典护手霜75g 1支', qty: 1, paid: '20.00' }],
  };
  await importOrders([O8]);
  const r = await importOrders([{ ...O8, subs: [{ ...O8.subs[0], refund: '5.00' }] }]);
  assert.equal(r.refunds.length, 1);
  const b0 = await stock(B);
  const set = await api('PUT', '/api/taobao/orders/T8/actual', { items: [{ product_id: C, qty: 1 }] });
  assert.equal(await stock(B), b0 + 1);
  const sale = (await api('GET', `/api/docs/${set.result.rebuilt_sales[0]}`)).doc;
  assert.equal(sale.items[0].product_id, C);
  assert.equal(sale.returns.length, 1);
  const ret = (await api('GET', `/api/docs/${sale.returns[0].id}`)).doc;
  assert.equal(ret.amount, 500);
  assert.equal(ret.items.length, 0);
  assert.deepEqual(ret.adjustments.map((a: any) => [a.name, a.amount]), [['退款', 500]]);
});

test('改单据日期和支出分类：不动金额；淘宝单据不能改日期', async () => {
  const doc = (await api('POST', '/api/docs', { type: 'expense', category: '其他', account_id: pub, amount: 100, doc_date: '2025-09-24' })).doc;
  const r = await api('PATCH', `/api/docs/${doc.id}`, { doc_date: '2026-09-24', category: '刷单' });
  assert.equal(r.doc.doc_date, '2026-09-24');
  assert.equal(r.doc.category, '刷单');
  await assert.rejects(api('PATCH', `/api/docs/${doc.id}`, { category: '不存在' }), /分类/);
  const tb = (await api('GET', '/api/docs?q=T1')).items.find((x: any) => x.status === 'active' && x.type === 'sale');
  await assert.rejects(api('PATCH', `/api/docs/${tb.id}`, { doc_date: '2026-01-01' }), /不能改/);
});

test('淘宝插件：连接码鉴权、领任务、上传商品 SKU 清单（自动猜对照待确认）和订单表', async () => {
  const agentApi = async (method: string, url: string, token: string, body?: unknown) => {
    const res = await app.inject({ method: method as any, url, payload: body as any, headers: { authorization: `Bearer ${token}` } });
    return { status: res.statusCode, json: res.json() };
  };
  assert.equal((await agentApi('POST', '/api/agent/next', 'nope')).status, 401);
  const { token } = await api('POST', '/api/plugin/token');
  assert.match(token, /^kc_/);
  assert.equal((await agentApi('POST', '/api/agent/next', token)).json.task, null);
  assert.ok((await api('GET', '/api/plugin')).last_seen);

  // 页面上点「拉取商品 SKU」→ 插件领到 → 回报完成；重复点不重复排
  const t1 = await api('POST', '/api/plugin/tasks', { kind: 'sync_skus' });
  const t2 = await api('POST', '/api/plugin/tasks', { kind: 'sync_skus' });
  assert.equal(t1.id, t2.id);
  const next = (await agentApi('POST', '/api/agent/next', token)).json.task;
  assert.deepEqual(next, { id: t1.id, kind: 'sync_skus' });
  const up = await agentApi('POST', '/api/agent/skus', token, {
    items: [
      { item_id: '100', title: '奥乐齐 LACURA柔光焕彩隔离霜40g', skus: [{ sku_id: '1', prop: 'LACURA隔离霜40g', price: '49.80' }] },
      { item_id: '600', title: '奥乐齐 LACURA 熊果苷发光水 200ml', skus: [{ sku_id: '2', prop: '熊果苷发光水200ml', price: '49.80' }] },
      { item_id: '700', title: '奥乐齐 没有规格的东西', skus: [] },
    ],
  });
  assert.equal(up.status, 200);
  assert.equal(up.json.result.items, 3);
  await agentApi('POST', `/api/agent/tasks/${t1.id}`, token, { ok: true, message: '3 个商品' });
  const st = await api('GET', '/api/plugin');
  assert.equal(st.tasks[0].status, 'done');

  const skus = (await api('GET', '/api/taobao/overview')).skus;
  const s600 = skus.find((x: any) => x.item_id === '600');
  assert.equal(s600.sku, '商品规格:熊果苷发光水200ml');
  assert.equal(s600.lines, 0);
  assert.equal(s600.state, 'auto'); // 没卖过也先猜好，等确认
  assert.equal(s600.products[0].product_id, C);
  assert.equal(s600.suggestions[0].product_id, C); // 候选按相似度排好，给人挑
  assert.ok(s600.suggestions[0].score >= 0.75);
  assert.equal(skus.find((x: any) => x.item_id === '100' && x.sku === '商品规格:LACURA隔离霜40g').state, 'confirmed'); // 已有对照不动
  assert.ok(skus.some((x: any) => x.item_id === '700' && x.sku === ''));

  // 插件自己按时同步订单：记一笔任务，上传两张表
  const own = (await agentApi('POST', '/api/agent/tasks', token, { kind: 'sync_orders' })).json.task;
  assert.equal(own.kind, 'sync_orders');
  const report = await importOrders([O1, O2], false, { url: '/api/agent/orders', headers: { authorization: `Bearer ${token}` } });
  assert.equal(report.created_sales.length, 0);
  assert.equal((await agentApi('POST', '/api/agent/debug', token, { message: '报表下载失败', attempts: [] })).status, 200);
  await api('POST', '/api/plugin/token'); // 重置后旧码失效
  assert.equal((await agentApi('POST', '/api/agent/next', token)).status, 401);
});
