// 命令行导入淘宝订单：npm run import:taobao -- 主订单.xlsx 子订单.xlsx [--dry] [--user lc]
// 两个文件顺序无所谓，按表头识别；--dry 只试跑不落库
import { readFileSync } from 'node:fs';
import { openDb, dryRun } from '../src/db.ts';
import { readXlsx } from '../src/xlsx.ts';
import { detectSheet, importTaobao } from '../src/taobao.ts';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const ui = args.indexOf('--user');
const username = ui >= 0 ? args[ui + 1] : 'lc';
const files = args.filter((a, i) => !a.startsWith('--') && !(ui >= 0 && i === ui + 1));

const db = openDb(process.env.DATA_DIR || './data');
const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined;
if (!user) throw new Error(`没有用户 ${username}`);

let orders: Record<string, string>[] = [];
let items: Record<string, string>[] = [];
for (const f of files) {
  const rows = readXlsx(readFileSync(f));
  const kind = detectSheet(rows);
  if (kind === 'orders') orders = rows;
  else if (kind === 'items') items = rows;
  else throw new Error(`认不出 ${f} 是主订单表还是子订单表`);
}

const run = () => importTaobao(db, user.id, orders, items);
const r = dry ? dryRun(db, run) : run();
console.log(`${dry ? '【试跑，未落库】' : ''}主订单 ${r.orders}，子订单 ${r.sub_orders}`);
console.log(`新生成销售单 ${r.created_sales.length} 张，补全重建 ${r.rebuilt_sales.length} 张，标记到账 ${r.received} 张，待处理退款 ${r.refunds.length} 张`);
console.log(`自动匹配 SKU ${r.auto_mapped} 个（待确认）；有商品没对上的销售单 ${r.unmatched_orders} 张（¥${(r.unmatched_amount / 100).toFixed(2)}，没扣库存），待发货 ${r.to_ship}`);
if (r.errors.length) console.log('出错：\n  ' + r.errors.join('\n  '));
if (r.negative.length) console.log('负库存：\n  ' + r.negative.map((p) => `${p.name} ${p.stock_qty}`).join('\n  '));
