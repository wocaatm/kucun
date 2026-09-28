export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.endsWith('/login')) onUnauthorized();
  if (!res.ok) throw new ApiError(data.error ?? `请求失败（${res.status}）`, res.status);
  return data as T;
}

export const get = <T = any>(url: string) => api<T>('GET', url);
export const post = <T = any>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});

// ---------- 金额：接口一律用「分」 ----------
export const toFen = (yuan: string | number): number => Math.round(Number(yuan) * 100);
export const toYuan = (fen: number): string => (fen / 100).toFixed(2).replace(/\.00$/, '');
export function money(fen: number | null | undefined, sign = false): string {
  if (fen == null) return '—';
  const s = Math.abs(fen / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const prefix = fen < 0 ? '-' : sign && fen > 0 ? '+' : '';
  return `${prefix}¥${s}`;
}

// ---------- 类型 ----------
export interface User {
  id: number;
  username: string;
  name: string;
}

export interface Account {
  id: number;
  kind: 'public' | 'person';
  name: string;
  user_id: number | null;
  balance: number;
}

export interface Meta {
  accounts: Account[];
  users: User[];
  expense_categories: string[];
  income_categories: string[];
  sale_channels: string[];
  outbound_categories: string[];
  profit_shares: Record<string, number>;
  low_stock_threshold: number;
  vision_enabled: boolean;
  catalogs: { source: string; count: number; synced_at: string }[];
}

/** 参考商品库（奥乐齐）里的一条：未建档时 product_id 为空 */
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
  product_id: number | null;
}

export const SOURCE_LABEL: Record<string, string> = { aldi: '奥乐齐' };

export interface Product {
  id: number;
  name: string;
  barcode: string | null;
  spec: string;
  category: string;
  image_upload_id: number | null;
  ref_price: number | null;
  note: string;
  stock_qty: number;
  stock_value: number;
  avg_cost: number | null;
  last_cost: number | null;
  sku_code: string | null;
  brand: string;
  image_url: string | null;
  source: string | null;
}

/** 商品图：自己传的优先，其次同步来的图片地址 */
export const productImage = (p: Pick<Product, 'image_upload_id' | 'image_url'>): string | null =>
  p.image_upload_id ? fileUrl(p.image_upload_id) : p.image_url;

export interface Upload {
  id: number;
  doc_id: number | null;
  kind: string;
  path: string;
  orig_path: string | null;
  note: string;
  created_by: number;
  created_by_name?: string;
  created_at: string;
  doc_type?: string;
  doc_category?: string;
  doc_amount?: number;
  doc_status?: string;
  doc_note?: string;
  doc_date?: string;
}

export interface DocItem {
  id: number;
  product_id: number;
  product_name: string;
  spec: string;
  barcode: string | null;
  qty: number;
  unit_price: number;
  amount: number;
  cost_amount: number;
  cost_pending: number;
  counted_qty: number | null;
  raw_name: string;
  /** 销售明细：已退回件数、已退款金额、单件卖出成本 */
  returned_qty?: number;
  refunded?: number;
  unit_cost?: number;
  /** 退货明细：退回入库成本、对应的销售明细 */
  in_cost?: number | null;
  ref_item_id?: number | null;
}

export interface TaobaoOrder {
  order_no: string;
  status: string;
  paid: number;
  postage: number;
  payout: number;
  shipped_at: string | null;
  confirmed_at: string | null;
  paid_at: string | null;
  remark: string;
  address: string;
  actual_state: string;
}

export interface Doc {
  id: number;
  type: DocType;
  category: string;
  doc_date: string;
  account_id: number | null;
  to_account_id: number | null;
  account_name?: string;
  to_account_name?: string;
  amount: number;
  channel: string;
  counterparty: string;
  note: string;
  status: 'active' | 'void';
  created_by_name: string;
  created_at: string;
  voided_by_name?: string;
  voided_at?: string;
  void_reason?: string;
  item_summary?: string;
  upload_count?: number;
  items?: DocItem[];
  uploads?: Upload[];
  /** 进货单的额外费用（正）/ 减免（负）；销售单的邮费（正） */
  adjustments?: { id: number; name: string; amount: number }[];
  /** 导入来源：taobao（由导入维护，不能手动作废） */
  source?: string | null;
  /** 淘宝订单号 */
  source_ref?: string | null;
  /** 销售单：0 = 钱未到账（淘宝应收） */
  received?: number | null;
  received_at?: string | null;
  /** 退货单：pending = 导入自动生成、待确认货是否退回 */
  review?: string;
  ref_doc_id?: number | null;
  returns?: { id: number; doc_date: string; amount: number; status: string; review: string }[];
  ref_doc?: { id: number; doc_date: string; amount: number; status: string; source_ref: string | null };
  taobao_order?: TaobaoOrder | null;
}

export type DocType =
  | 'purchase'
  | 'sale'
  | 'sale_return'
  | 'outbound'
  | 'stocktake'
  | 'opening_stock'
  | 'expense'
  | 'income'
  | 'transfer'
  | 'opening_balance';

export const DOC_LABEL: Record<DocType, string> = {
  purchase: '进货',
  sale: '销售',
  sale_return: '退货退款',
  outbound: '出库',
  stocktake: '盘点',
  opening_stock: '期初库存',
  expense: '支出',
  income: '收入',
  transfer: '转账',
  opening_balance: '期初余额',
};

export const UPLOAD_KIND_LABEL: Record<string, string> = {
  receipt: '小票',
  sale_shot: '卖货截图',
  expense: '消费照片',
  other: '其他',
};

export const fileUrl = (id: number, orig = false) => `/files/${id}${orig ? '?orig=1' : ''}`;

/** 单据对钱的影响（用于列表里显示正负号） */
export function docMoneySign(d: Pick<Doc, 'type' | 'amount'>): number {
  switch (d.type) {
    case 'purchase':
    case 'expense':
    case 'sale_return':
      return -d.amount;
    case 'sale':
    case 'income':
    case 'opening_balance':
      return d.amount;
    default:
      return 0;
  }
}
