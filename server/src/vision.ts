import { readFileSync } from 'node:fs';
import type { DB } from './db.ts';
import { normalizeName } from './docs.ts';

// OpenAI 兼容的多模态接口；换 Qwen-VL 等只需改环境变量
const cfg = () => ({
  baseUrl: process.env.VISION_BASE_URL ?? 'https://api.deepseek.com',
  model: process.env.VISION_MODEL ?? 'deepseek-flash',
  apiKey: process.env.VISION_API_KEY ?? '',
});

export type RecognizeMode = 'purchase' | 'sale';

export interface RecognizedLine {
  name: string;
  barcode?: string;
  qty: number;
  unit_price: number; // 元
}

export interface Recognized {
  date?: string;
  store?: string;
  buyer?: string;
  channel?: string;
  order_no?: string;
  total?: number;
  items: RecognizedLine[];
}

const PROMPTS: Record<RecognizeMode, string> = {
  purchase: `这是一张购物小票（可能来自山姆、ALDI 奥乐齐、超市或网购订单截图）。请提取所有商品行。
规则：
- unit_price 为该商品实际支付的单价（元，若有行内优惠请折算到单价），qty 为数量（整数，称重商品记 1）。
- name 保留小票上的商品名原文；小票上有条码/货号就填 barcode，没有就省略。
- 不要把小计、合计、优惠券、会员费、找零、支付方式当成商品。
- date 为 YYYY-MM-DD，store 为门店或平台名，total 为实付总额（元）。
只输出 JSON，字段：date, store, total, items（数组，每项含 name, barcode, qty, unit_price）。`,
  sale: `这是一张卖货截图（最常见是淘宝/千牛的订单详情或订单列表，也可能是微信聊天、闲鱼/小红书订单、转账记录）。请提取卖出的每个商品。
规则：
- 逐个商品读：商品旁边「¥xx.xx」是单价，「×N」或「x N」是数量；unit_price 取单价数字（元），qty 取 N（整数）。只有总价时用总价除以数量。不要填 0，看不清就按实付款和数量推算。
- name 为商品名：淘宝标题较长，去掉【】里的宣传语和「现货/包邮/办公室零食」这类营销词，保留品牌、品名和规格。
- 运费不算商品；total 为买家实付款（元）。buyer 为买家昵称/会员名，order_no 为订单编号。
- channel 从截图判断：淘宝 / 微信 / 闲鱼 / 小红书，看不出则省略；date 为 YYYY-MM-DD，看不出则省略。
只输出 JSON，字段：date, channel, buyer, order_no, total, items（数组，每项含 name, qty, unit_price）。`,
};

export async function recognizeImage(imagePath: string, mode: RecognizeMode): Promise<Recognized> {
  const { baseUrl, model, apiKey } = cfg();
  if (!apiKey) throw new Error('未配置识别模型的 API Key');
  const buf = readFileSync(imagePath);
  const b64 = buf.toString('base64');
  // 按文件头判断格式，别把 PNG 标成 JPEG
  const mime = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : buf.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/jpeg';
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
            { type: 'text', text: PROMPTS[mode] },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`识别服务出错（${res.status}）：${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return parseRecognized(data.choices[0]?.message?.content ?? '');
}

/** 模型偶尔会在前面多吐一段 {"type":"json_object"}：逐个解析顶层 JSON 对象，取带 items 的那个 */
function pickJson(text: string): any {
  const objs: any[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth++ === 0) start = i;
    } else if (ch === '}' && depth > 0 && --depth === 0) {
      try {
        objs.push(JSON.parse(text.slice(start, i + 1)));
      } catch {
        /* 跳过坏片段 */
      }
    }
  }
  const hit = objs.find((o) => Array.isArray(o?.items)) ?? objs[objs.length - 1];
  if (!hit) throw new Error('识别结果不是 JSON');
  return hit;
}

export function parseRecognized(text: string): Recognized {
  const raw = pickJson(text);
  const num = (v: unknown) => {
    const n = typeof v === 'string' ? parseFloat(v.replace(/[^\d.-]/g, '')) : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const items: RecognizedLine[] = (Array.isArray(raw.items) ? raw.items : [])
    .filter((it: any) => it && String(it.name ?? '').trim())
    .map((it: any) => ({
      name: String(it.name).trim(),
      barcode: it.barcode ? String(it.barcode).replace(/\D/g, '') || undefined : undefined,
      qty: Math.max(1, Math.round(num(it.qty) || 1)),
      unit_price: num(it.unit_price),
    }));
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(raw.date ?? '') ? raw.date : undefined,
    store: raw.store || undefined,
    buyer: raw.buyer || undefined,
    channel: raw.channel || undefined,
    order_no: raw.order_no ? String(raw.order_no) : undefined,
    total: raw.total ? num(raw.total) : undefined,
    items,
  };
}

function bigrams(s: string): string[] {
  if (s.length < 2) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** 简称匹配：a 的每个字按顺序出现在 b 里，如「维c」→「ks维生素c」 */
export function isSubsequence(a: string, b: string): boolean {
  let i = 0;
  for (const ch of b) if (ch === a[i]) i++;
  return a.length > 0 && i === a.length;
}

/**
 * 长标题匹配：商品名里的中文按顺序都出现在标题里，就认为很像。
 * 淘宝标题常带「【代购】现货 包邮」等营销词，普通相似度会被拉低。中文越长越可信。
 */
export function titleScore(title: string, name: string): number {
  const cjk = (s: string) => s.replace(/[^\u4e00-\u9fff]/g, '');
  const n = cjk(name);
  if (n.length < 3 || !isSubsequence(n, cjk(title))) return 0;
  return Math.min(0.95, 0.75 + n.length * 0.02);
}

/** 综合相似度：完全相同 > 互相包含 > 长标题 / 简称 / 二元组相似度 */
export function nameScore(key: string, n: string): number {
  if (n === key) return 1;
  if (n.includes(key) || key.includes(n)) return 0.85;
  return Math.max(similarity(key, n), isSubsequence(key, n) ? 0.6 : 0, titleScore(key, n));
}

export function similarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  const pool = [...B];
  let hit = 0;
  for (const g of A) {
    const k = pool.indexOf(g);
    if (k >= 0) {
      hit++;
      pool.splice(k, 1);
    }
  }
  return (2 * hit) / (A.length + B.length);
}

interface ProductLite {
  id: number;
  name: string;
  spec: string;
  barcode: string | null;
  stock_qty: number;
}

/** 条码 → 记住的别名 → 同名 → 相似度，返回匹配结果和候选 */
export function matchProduct(db: DB, name: string, barcode?: string) {
  const cols = 'id, name, spec, barcode, stock_qty';
  if (barcode) {
    const p = (db.prepare(`SELECT ${cols} FROM products WHERE barcode = ?`).get(barcode) ??
      db.prepare(`SELECT ${cols} FROM products WHERE sku_code = ?`).get(barcode)) as ProductLite | undefined;
    if (p) return { product: p, by: 'barcode', candidates: [] as ProductLite[] };
  }
  const key = normalizeName(name);
  const alias = db
    .prepare(`SELECT ${cols} FROM products WHERE id = (SELECT product_id FROM product_aliases WHERE alias = ?)`)
    .get(key) as ProductLite | undefined;
  if (alias) return { product: alias, by: 'alias', candidates: [] as ProductLite[] };

  const all = db.prepare(`SELECT ${cols} FROM products`).all() as unknown as ProductLite[];
  const scored = all
    .map((p) => {
      return { p, s: nameScore(key, normalizeName(p.name)) };
    })
    .filter((x) => x.s >= 0.3)
    .sort((a, b) => b.s - a.s);
  const top = scored[0];
  const clear = top && top.s >= 0.85 && (!scored[1] || scored[1].s < top.s);
  return {
    product: clear ? top.p : null,
    by: clear ? 'name' : null,
    candidates: scored.slice(0, 3).map((x) => x.p),
  };
}
