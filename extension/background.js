// 小库存 · 淘宝助手：每分钟醒一次
// - 到了每天的同步时间：导出订单报表 + 宝贝明细报表，下载后上传到小库存（和手动导入 Excel 同一条路）
// - 小库存页面上点了「同步订单 / 拉取商品 SKU」：来这里领任务执行
// 订单同步分几步跨越多次唤醒（千牛两次导出要隔 5 分钟），进度存在 storage 里
import { Taobao, SOLD_URL, LOGIN_RE } from './taobao.js';

const DEFAULTS = { server: 'https://kucun.kidslearnenglish.xyz', token: '', dailyAt: '21:30', tbUser: '', tbPass: '' };
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

const LOGIN_WAIT = 30 * 60 * 1000; // 弹了滑块 / 短信等人处理，最多等这么久

/** 找一个已打开的千牛页面（含跳到登录页的）；没有就在后台开一个（任务结束后关掉） */
async function taobaoTab(job) {
  if (job.ownTab) {
    const t = await chrome.tabs.get(job.ownTab).catch(() => null);
    if (t) return waitLoaded(t.id);
  }
  const tabs = await chrome.tabs.query({ url: ['https://myseller.taobao.com/*', 'https://qn.taobao.com/*', 'https://loginmyseller.taobao.com/*'] });
  const open = tabs.find((t) => t.status === 'complete');
  if (open) return open.id;
  const tab = await chrome.tabs.create({ url: SOLD_URL, active: false });
  job.ownTab = tab.id;
  await store.set('job', job);
  return waitLoaded(tab.id);
}

async function waitLoaded(tabId) {
  for (let i = 0; i < 60; i++) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return tabId;
    await sleep(500);
  }
  throw new Error('打开千牛页面超时');
}

const onLoginPage = async (tabId) => LOGIN_RE.test((await chrome.tabs.get(tabId)).url ?? '');

/** 在登录 iframe 里填账号密码、点登录（在页面里执行；找不到表单返回 false） */
function fillLogin(user, pass) {
  const id = document.querySelector('#fm-login-id');
  const pw = document.querySelector('#fm-login-password');
  const btn = document.querySelector('button.fm-submit');
  if (!id || !pw || !btn) return false;
  // 登录表单是 React 写的：要用原生 setter 赋值再发 input 事件，它才认
  const set = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  set(id, user);
  set(pw, pass);
  btn.click();
  return true;
}

/**
 * 保证千牛登着：没登录就用插件里填的账号密码自动登录一次；
 * 淘宝弹了滑块 / 短信验证就把页面切到前台、发通知等人处理（插件不碰验证），登上后自动继续。
 * 返回 true = 可以干活；false = 还在等人登录（任务留着，下次唤醒再看）。
 */
async function ensureLogin(job, tabId) {
  if (!(await onLoginPage(tabId))) {
    if (job.waitLogin) {
      delete job.waitLogin;
      await log('千牛已登录，继续');
    }
    return true;
  }
  const cfg = await config();
  if (!job.loginTried) {
    if (!cfg.tbUser || !cfg.tbPass) throw new Error('千牛登录过期，插件里没填千牛账号密码，请在浏览器里登录千牛后再试');
    job.loginTried = Date.now();
    await store.set('job', job);
    await log('千牛登录过期，自动登录');
    // 登录表单在 iframe 里，等它加载出来
    let filled = false;
    for (let i = 0; i < 20 && !filled; i++) {
      await sleep(1000);
      const res = await chrome.scripting
        .executeScript({ target: { tabId, allFrames: true }, func: fillLogin, args: [cfg.tbUser, cfg.tbPass] })
        .catch(() => []);
      filled = res.some((r) => r.result);
    }
    if (filled) {
      for (let i = 0; i < 20; i++) {
        await sleep(1000);
        if (!(await onLoginPage(tabId))) {
          await log('自动登录成功');
          if (!/trade-platform/.test((await chrome.tabs.get(tabId)).url ?? '')) {
            await chrome.tabs.update(tabId, { url: SOLD_URL });
            await sleep(1000);
            await waitLoaded(tabId);
          }
          return true;
        }
      }
    }
  }
  // 自动登录没成（多半是要滑块 / 短信验证）：叫人来
  if (!job.waitLogin) {
    job.waitLogin = Date.now();
    await store.set('job', job);
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    chrome.notifications.create('login', {
      type: 'basic',
      iconUrl: 'icon.png',
      title: '小库存 · 千牛要登录',
      message: '淘宝要求验证（滑块或短信），请在打开的千牛页面完成登录，插件登上后自动继续同步',
      requireInteraction: true,
    });
    await log('自动登录需要验证，已提醒手动完成');
  }
  if (Date.now() - job.waitLogin > LOGIN_WAIT) throw new Error('等千牛登录超时（需要手动完成滑块 / 短信验证）');
  return false;
}

// 点通知：切到千牛登录页
chrome.notifications.onClicked.addListener(async (id) => {
  if (id !== 'login') return;
  const job = await store.get('job', null);
  const tabs = await chrome.tabs.query({ url: ['https://loginmyseller.taobao.com/*', 'https://myseller.taobao.com/*'] });
  const t = (job?.ownTab && tabs.find((x) => x.id === job.ownTab)) || tabs[0];
  if (t) {
    await chrome.tabs.update(t.id, { active: true });
    await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
  }
});

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
    // 千牛上 30 分钟内刚生成、插件还没导入过的两份报表（比如上次下载失败），直接用，不再等 7 分钟
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

/** 最新的订单报表和宝贝明细报表都生成好、30 分钟内申请的、还没导入过（再旧就重新导出，保证拿到最新订单） */
async function reusable(list) {
  const done = await store.get('uploaded', []);
  const newest = (type) => list.find((x) => String(x.exportType) === type);
  const [orders, items] = [newest('1'), newest('2')];
  const fresh = (x) =>
    x && x.exportStatus === 'exportSuccess' && !done.includes(String(x.exportId)) &&
    Date.now() - Date.parse(`${x.applyTime.replace(' ', 'T')}+08:00`) < 30 * 60 * 1000;
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
  chrome.notifications.clear('login');
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
    const tabId = await taobaoTab(job);
    if (!(await ensureLogin(job, tabId))) return void (await store.set('job', job));
    const tb = new Taobao(tabId);
    const done = job.kind === 'sync_skus' ? await runSkus(tb) : await stepOrders(tb, job);
    if (done) await finish(job, true, done);
    else await store.set('job', job);
  } catch (e) {
    // 干到一半登录过期：把页面带回千牛（会跳登录页），下一分钟自动登录后接着做
    if (e.login && job && !job.loginTried) {
      const tabs = await chrome.tabs.query({ url: ['https://myseller.taobao.com/*', 'https://qn.taobao.com/*'] });
      const t = (job.ownTab && tabs.find((x) => x.id === job.ownTab)) || tabs[0];
      if (t) await chrome.tabs.update(t.id, { url: SOLD_URL });
      await store.set('job', job);
      await log('千牛登录过期，下一分钟自动登录后继续');
      return;
    }
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
