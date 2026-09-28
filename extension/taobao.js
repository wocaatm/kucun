// 千牛网页接口：请求都放到已登录的千牛标签页里发（带店主的 cookie），这里只负责拼参数、签名和解析
import { md5 } from './md5.js';

const APP_KEY = '12574478';
export const SOLD_URL = 'https://myseller.taobao.com/home.htm/trade-platform/tp/sold';

/** 在千牛标签页里发一个请求；as = json | text | base64 */
function pageFetch(req) {
  return (async () => {
    const r = await fetch(req.url, {
      method: req.method ?? 'GET',
      credentials: 'include',
      headers: req.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
      body: req.body,
      // 下载报表时像在「订单导出报表」页点按钮一样带上完整来源页
      ...(req.referrer ? { referrer: req.referrer, referrerPolicy: 'unsafe-url' } : {}),
    });
    const out = { status: r.status, url: r.url };
    if (req.as === 'base64') {
      const bytes = new Uint8Array(await r.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      out.data = btoa(bin);
      out.type = r.headers.get('content-type') ?? '';
    } else {
      const text = await r.text();
      out.data = req.as === 'json' ? JSON.parse(text) : text;
    }
    return out;
  })();
}

export class Taobao {
  constructor(tabId) {
    this.tabId = tabId;
  }

  async fetch(req) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: this.tabId }, world: 'MAIN', func: pageFetch, args: [req] });
    if (res.error) throw new Error(res.error.message ?? String(res.error));
    const out = res.result;
    if (/login\.taobao\.com|loginmyseller/.test(out.url)) throw new Error('千牛没登录或登录过期，请在浏览器里重新登录千牛');
    return out;
  }

  /** mtop 接口：sign = md5(token&t&appKey&data)，token 过期时淘宝会下发新的，重试一次 */
  async mtop(api, data, retry = true, opts = {}) {
    const ck = await chrome.cookies.get({ url: 'https://h5api.m.taobao.com/', name: '_m_h5_tk' });
    const token = (ck?.value ?? '').split('_')[0];
    const t = Date.now();
    const d = JSON.stringify(data);
    const sign = md5(`${token}&${t}&${APP_KEY}&${d}`);
    const base = `https://h5api.m.taobao.com/h5/${api}/1.0/?jsv=2.6.1&appKey=${APP_KEY}&t=${t}&sign=${sign}&api=${api}&v=1.0&type=originaljson&dataType=json`;
    const r = opts.get
      ? await this.fetch({ url: `${base}&valueType=string&data=${encodeURIComponent(d)}`, as: 'json' })
      : await this.fetch({ url: base, method: 'POST', body: 'data=' + encodeURIComponent(d), as: 'json' });
    const ret = String(r.data?.ret?.[0] ?? '');
    if (ret.startsWith('SUCCESS')) return r.data.data;
    if (retry && /TOKEN_EMPTY|TOKEN_EXOIRED|TOKEN_EXPIRED/.test(ret)) return this.mtop(api, data, false, opts);
    if (/RGV587|FAIL_SYS_USER_VALIDATE/.test(ret)) throw new Error('淘宝要求验证（滑块），请打开千牛页面手动验证后再试');
    throw new Error(`${api}：${ret || '请求失败'}`);
  }

  // ---------------------------------------------------------------- 订单报表

  /** 申请导出：1 = 订单报表（主订单），2 = 宝贝销售明细报表（子订单）；近 3 个月、全部字段 */
  async applyExport(exportType) {
    const params = new URLSearchParams({ ...EXPORT_BASE, exportType: String(exportType), selectFieldIds: FIELDS[exportType] });
    const r = await this.fetch({
      url: 'https://trade.taobao.com/trade/itemlist/list_export_order.htm?_input_charset=utf8',
      method: 'POST',
      body: params.toString(),
      as: 'text',
    });
    if (r.status !== 200) throw new Error(`申请导出失败（HTTP ${r.status}）`);
    if (/5分钟内只能导出一次/.test(r.data)) throw new Error('千牛限制 5 分钟内只能导出一次，稍后再试');
  }

  /** 已生成的报表（最近的在前）：{ exportId, exportType, exportStatus, applyTime, ... } */
  async exportList() {
    const d = await this.mtop('mtop.taobao.trade.order.exportlist', { page: 1 }, true, { get: true });
    const list = typeof d.detailList === 'string' ? JSON.parse(d.detailList) : d.detailList;
    return list ?? [];
  }

  /**
   * 下载一份报表，返回 base64。
   * 先由插件后台直接请求（有淘宝域名权限，不受跨域限制，带浏览器里的登录 cookie）；不行再从千牛页面里请求。
   */
  async download(x) {
    const need = { f_p: x.orderEncrypterStr, apply_time: x.applyTime, start_time: x.startTimeStr, end_time: x.endTimeStr, export_id: x.exportId };
    const missing = Object.keys(need).filter((k) => !need[k]);
    if (missing.length) throw Object.assign(new Error(`报表信息缺字段 ${missing.join('、')}`), { debug: { report: x } });
    // 和千牛页面一样用 %20 编码空格；URLSearchParams 会编成 +，淘宝不认，返回错误页
    const q = Object.entries({ ...need, order_status: x.orderStatus || '全部', isQnNew: 'true' })
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    // 参数顺序也照千牛页面
    const url = `https://trade.taobao.com/trade/itemlist/export_by_tfs.do?${reorder(q)}`;
    const attempts = [];
    // 1. 从千牛页面里请求，带上「订单导出报表」页作为来源（和手动点下载一样）
    try {
      const r = await this.fetch({ url, as: 'base64', referrer: 'https://myseller.taobao.com/home.htm/trade-platform/tp/export-list' });
      const buf = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
      if (r.status === 200 && isXlsx(buf)) return r.data;
      attempts.push({ via: '页面', status: r.status, type: r.type, text: decode(buf) });
    } catch (e) {
      attempts.push({ via: '页面', error: e.message ?? String(e) });
    }
    // 2. 插件后台直接请求（有淘宝域名权限，不受跨域限制）
    try {
      const r = await fetch(url, { credentials: 'include' });
      const buf = new Uint8Array(await r.arrayBuffer());
      if (r.ok && isXlsx(buf)) return toBase64(buf);
      attempts.push({ via: '后台', status: r.status, type: r.headers.get('content-type') ?? '', text: decode(buf) });
    } catch (e) {
      attempts.push({ via: '后台', error: e.message ?? String(e) });
    }
    const brief = attempts.map((a) => `${a.via} ${a.error ?? `HTTP ${a.status} ${summary(a.text)}`}`).join('；');
    throw Object.assign(new Error(`报表下载失败（${brief}）`), { debug: { report: x, url, attempts } });
  }

  // ---------------------------------------------------------------- 商品 SKU

  async manage(url, body) {
    const d = await this.mtop('mtop.taobao.sell.pc.manage.async', { url, jsonBody: JSON.stringify(body) });
    const r = JSON.parse(d.result);
    if (!r.success) throw new Error('读取商品失败');
    return r.data;
  }

  /** 我的商品（全部，含仓库中），每页 20 个 */
  async itemPage(page) {
    const d = await this.manage('/taobao/manager/table.htm', { tab: 'all', pagination: { current: page, pageSize: 20 }, filtertab: '', filter: {}, table: {} });
    return (d.table?.dataSource ?? []).map((it) => ({
      item_id: String(it.itemId),
      title: it.itemDesc?.desc?.[0]?.text ?? '',
      status: it.upShelfDate_m?.status?.text ?? '',
    }));
  }

  /** 一个商品的全部 SKU（只读「编辑价格」弹窗的数据，不提交） */
  async itemSkus(itemId) {
    const d = await this.manage('/taobao/manager/fastEdit.htm?optType=editSku&action=render', { itemId });
    return (d.value?.skuTable?.dataSource ?? []).map((s) => ({ sku_id: String(s.skuId), prop: s.prop, price: s.skuPrice }));
  }
}

// xlsx 是 zip，开头是 PK
const isXlsx = (buf) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
/** 淘宝网页是 GBK；解不了就按 UTF-8 */
function decode(buf) {
  const bytes = buf.slice(0, 50000);
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}
/** 返回的不是文件时，给出网页标题和正文开头，方便看出原因 */
function summary(html) {
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? '';
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, ' ').replace(/\s+/g, ' ').trim();
  return `「${title}」${body.slice(0, 120)}`;
}
const ORDER = ['f_p', 'apply_time', 'start_time', 'end_time', 'order_status', 'export_id', 'isQnNew'];
const reorder = (q) =>
  q
    .split('&')
    .sort((a, b) => ORDER.indexOf(a.split('=')[0]) - ORDER.indexOf(b.split('=')[0]))
    .join('&');
function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// 千牛「批量导出」表单（2026-09 抓的；近 3 个月、全部订单状态）
const EXPORT_BASE = {
  useCheckcode: 'false', errorCheckcode: 'false', payDateBegin: '0', rateStatus: 'ALL', orderStatus: 'ALL', pageSize: '15',
  dateEnd: '0', endTimeBegin: '0', endTimeEnd: '0', rxOldFlag: '0', rxSendFlag: '0', dateBegin: '0', tradeTag: '0',
  action: 'itemlist/ExportOrderAction', rxHasSendFlag: '0', auctionType: '0', close: '0', notifySendGoodsType: 'ALL',
  sellerMemoFlag: '0', useOrderInfo: 'false', logisticsService: 'ALL', isQnNew: 'true', pageNum: '1', o2oDeliveryType: 'ALL',
  rxAuditFlag: '0', queryOrder: 'desc', holdStatus: '0', rxElectronicAuditFlag: '0', queryMore: 'true', payDateEnd: '0',
  rxWaitSendflag: '0', sellerMemo: '0', tabCode: 'latest3Months', queryBizType: 'ALL', rxElectronicAllFlag: '0',
  rxSuccessflag: '0', unionSearchTotalNum: '0', refund: 'ALL', unionSearchPageNum: '0', yushouStatus: 'ALL',
  deliveryTimeType: 'ALL', payMethodType: 'ALL', orderType: 'ALL', isRiskOrder: '0', fileType: 'xlsx',
  newExportPlatform: 'true', event_submit_do_apply_export: '1',
};
const FIELDS = {
  1: '1,10,11,14,16,17,20,21,22,23,24,25,26,27,28,29,30,36,37,38,39,41,43,45,46,51,52,53,55,88,90,93,95,2,3,4,5,6,7,8,9,15,31,33,34,35,44,50,54,58,63,69,85,89,91,96,97,12,13,18,19,40,42,47,49,73,74,75,56,57,59,65,66,68,71,72,86,87,92,94,98,60,61,62,64,67,70,76,77,83,84,78,79,80,81,82',
  2: '1,2,3,4,5,6,7,8,9,10,11,17,19,20,21,22,23,24,12,13,14,15,16,18,28,29,30,25,26,27,31,37,32,35,36,38,33,34',
};
