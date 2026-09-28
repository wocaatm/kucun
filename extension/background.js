// 小库存 · 淘宝助手：每分钟醒一次
// - 到了每天的同步时间：导出订单报表 + 宝贝明细报表，下载后上传到小库存（和手动导入 Excel 同一条路）
// - 小库存页面上点了「同步订单 / 拉取商品 SKU」：来这里领任务执行
// 订单同步分几步跨越多次唤醒（千牛两次导出要隔 5 分钟），进度存在 storage 里
import { Taobao, SOLD_URL } from './taobao.js';

const DEFAULTS = { server: 'https://kucun.kidslearnenglish.xyz', token: '', dailyAt: '21:30' };
const EXPORT_GAP = 5.5 * 60 * 1000; // 两次导出间隔（千牛要求 ≥ 5 分钟）
const ORDER_TIMEOUT = 40 * 60 * 1000;
const STEP_DELAY = 1200; // 连续请求之间停一下，别刷太快触发风控

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get: async (k, d) => (await chrome.storage.local.get(k))[k] ?? d,
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
};
const config = async () => ({ ...DEFAULTS, ...(await store.get('config', {})) });

async function log(text) {
  const logs = await store.get('logs', []);
  logs.unshift(`${new Date().toLocaleString('zh-CN', { hour12: false })} ${text}`);
  await store.set('logs', logs.slice(0, 40));
}

// ---------------------------------------------------------------- 小库存服务器

async function server(path, body, form) {
  const cfg = await config();
  if (!cfg.token) throw new Error('还没填连接码');
  const res = await fetch(cfg.server.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, ...(form ? {} : { 'content-type': 'application/json' }) },
    body: form ?? JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `小库存返回 ${res.status}`);
  return json;
}

// ---------------------------------------------------------------- 千牛标签页

/** 找一个已打开的千牛页面；没有就在后台开一个（任务结束后关掉） */
async function taobaoTab(job) {
  const tabs = await chrome.tabs.query({ url: ['https://myseller.taobao.com/*', 'https://qn.taobao.com/*'] });
  const open = tabs.find((t) => t.status === 'complete');
  if (open) return open.id;
  const tab = await chrome.tabs.create({ url: SOLD_URL, active: false });
  job.ownTab = tab.id;
  await store.set('job', job);
  for (let i = 0; i < 60; i++) {
    const t = await chrome.tabs.get(tab.id);
    if (t.status === 'complete') {
      if (/login/.test(t.url ?? '')) throw new Error('千牛没登录或登录过期，请在浏览器里重新登录千牛');
      return tab.id;
    }
    await sleep(500);
  }
  throw new Error('打开千牛页面超时');
}

// ---------------------------------------------------------------- 任务

const newJob = (task) => ({ taskId: task.id, kind: task.kind, step: 'start', startedAt: Date.now() });

async function runSkus(tb) {
  const items = [];
  for (let page = 1; page <= 50; page++) {
    const rows = await tb.itemPage(page);
    items.push(...rows);
    if (rows.length < 20) break;
    await sleep(STEP_DELAY);
  }
  for (const it of items) {
    await sleep(STEP_DELAY);
    it.skus = await tb.itemSkus(it.item_id);
  }
  const r = await server('/api/agent/skus', { items });
  return `${r.result.items} 个商品、${r.result.skus} 个 SKU，新猜了 ${r.result.auto_mapped} 个对照（待确认）`;
}

/** 订单同步的一步；返回完成信息，没做完返回 null（下次唤醒继续） */
async function stepOrders(tb, job) {
  if (Date.now() - job.startedAt > ORDER_TIMEOUT) throw new Error('等报表生成超时');
  if (job.step === 'start') {
    const list = await tb.exportList();
    // 千牛上已有刚生成、还没导入过的两份报表（比如上次下载失败），直接用，不再等 7 分钟
    const reuse = await reusable(list);
    if (reuse) {
      await log('千牛上已有刚生成的两份报表，直接下载');
      return upload(tb, reuse.orders, reuse.items);
    }
    job.before = list.map((x) => String(x.exportId));
    await tb.applyExport(1);
    Object.assign(job, { step: 'gap', applied1: Date.now() });
    await log('已申请导出订单报表，5 分钟后申请宝贝明细报表');
    return null;
  }
  if (job.step === 'gap') {
    if (Date.now() - job.applied1 < EXPORT_GAP) return null;
    await tb.applyExport(2);
    job.step = 'wait';
    await log('已申请导出宝贝明细报表，等报表生成');
    return null;
  }
  // wait：两份新报表都生成好了就下载上传
  const fresh = (await tb.exportList()).filter((x) => !job.before.includes(String(x.exportId)));
  const pick = (type) => fresh.find((x) => String(x.exportType) === type && x.exportStatus === 'exportSuccess');
  const [orders, items] = [pick('1'), pick('2')];
  if (!orders || !items) return null;
  return upload(tb, orders, items);
}

/** 最新的订单报表和宝贝明细报表都生成好、3 小时内申请的、还没导入过 */
async function reusable(list) {
  const done = await store.get('uploaded', []);
  const newest = (type) => list.find((x) => String(x.exportType) === type);
  const [orders, items] = [newest('1'), newest('2')];
  const fresh = (x) =>
    x && x.exportStatus === 'exportSuccess' && !done.includes(String(x.exportId)) &&
    Date.now() - Date.parse(`${x.applyTime.replace(' ', 'T')}+08:00`) < 3 * 3600 * 1000;
  return fresh(orders) && fresh(items) ? { orders, items } : null;
}

async function upload(tb, orders, items) {
  const form = new FormData();
  for (const [x, name] of [[orders, 'orders.xlsx'], [items, 'items.xlsx']]) {
    await sleep(STEP_DELAY);
    const bin = Uint8Array.from(atob(await tb.download(x)), (c) => c.charCodeAt(0));
    form.append(name, new Blob([bin], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
  }
  form.append('dry', '0');
  const { report: r } = await server('/api/agent/orders', null, form);
  await store.set('uploaded', [String(orders.exportId), String(items.exportId), ...(await store.get('uploaded', []))].slice(0, 20));
  return `导入 ${r.orders} 单：新销售 ${r.created_sales.length}，到账 ${r.received}，退款 ${r.refunds.length}，没对上 ${r.unmatched_orders} 单`;
}

async function finish(job, ok, message) {
  await store.set('job', null);
  if (job.ownTab) chrome.tabs.remove(job.ownTab).catch(() => {});
  await server(`/api/agent/tasks/${job.taskId}`, { ok, message }).catch(() => {});
  await log(`${job.kind === 'sync_skus' ? '拉取 SKU' : '同步订单'}${ok ? '完成' : '失败'}：${message}`);
  if (!ok) chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png', title: '小库存 · 淘宝助手', message });
}

// ---------------------------------------------------------------- 每分钟

let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  let job = null;
  try {
    const cfg = await config();
    if (!cfg.token) return;
    job = await store.get('job', null);
    if (!job) {
      const today = new Date().toLocaleDateString('sv');
      const hm = new Date().toTimeString().slice(0, 5);
      if (hm >= cfg.dailyAt && (await store.get('lastDaily', '')) !== today) {
        await store.set('lastDaily', today);
        job = newJob((await server('/api/agent/tasks', { kind: 'sync_orders' })).task);
      } else {
        const { task } = await server('/api/agent/next');
        if (!task) return;
        job = newJob(task);
      }
      await store.set('job', job);
      await log(`开始${job.kind === 'sync_skus' ? '拉取商品 SKU' : '同步订单'}`);
    }
    const tb = new Taobao(await taobaoTab(job));
    const done = job.kind === 'sync_skus' ? await runSkus(tb) : await stepOrders(tb, job);
    if (done) await finish(job, true, done);
    else await store.set('job', job);
  } catch (e) {
    // 出错现场（淘宝返回的网页等）传到小库存，方便排查
    if (e.debug) await server('/api/agent/debug', { message: e.message, ...e.debug }).catch(() => {});
    if (job) await finish(job, false, e.message ?? String(e));
    else await log(`出错：${e.message ?? e}`);
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------- 入口

const setup = () => chrome.alarms.create('tick', { periodInMinutes: 1 });
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
chrome.alarms.onAlarm.addListener((a) => a.name === 'tick' && tick());

// 弹窗：立即执行 / 查看状态
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === 'run') {
      if (await store.get('job', null)) throw new Error('有任务正在进行，等它做完');
      const { task } = await server('/api/agent/tasks', { kind: msg.kind });
      await store.set('job', newJob(task));
      tick();
      return { ok: true };
    }
    if (msg.type === 'cancel') {
      const job = await store.get('job', null);
      if (job) await finish(job, false, '手动取消');
      return { ok: true };
    }
    return { job: await store.get('job', null), logs: await store.get('logs', []) };
  })().then(reply, (e) => reply({ error: e.message ?? String(e) }));
  return true;
});
