import { useState } from 'react';
import { Button, Dialog, Input, Stepper, Toast } from 'antd-mobile';
import { AddOutline, DeleteOutline, ScanningOutline, ExclamationCircleFill } from 'antd-mobile-icons';
import { get, money, toFen, toYuan, SOURCE_LABEL, type CatalogItem, type Product } from '../api';
import ProductPicker, { StockTag, catalogToProduct } from './ProductPicker';
import Scanner from './Scanner';

export type EditorMode = 'purchase' | 'sale' | 'outbound' | 'stocktake' | 'opening_stock';

export interface Line {
  key: string;
  product: Product | null;
  qty: number;
  price: string; // 元；进货时是这一行的总价（含运费等），其余是单价
  counted?: number;
  raw_name?: string;
  barcode?: string | null;
  candidates?: Product[];
  /** 商品表没有、参考库匹配上了：提交时自动建档 */
  catalog?: CatalogItem | null;
  catalogCandidates?: CatalogItem[];
}

let seq = 0;
export const newKey = () => `l${++seq}`;

/** 进货填的是整行总价，不同件数没法套上次的价，留空 */
export const isTotalMode = (mode: EditorMode) => mode === 'purchase';

export function defaultPrice(p: Product, mode: EditorMode): string {
  if (isTotalMode(mode)) return '';
  const fen = mode === 'sale' ? p.ref_price : p.last_cost ?? p.avg_cost;
  return fen != null ? toYuan(fen) : '';
}

export function lineAmount(l: Line, mode: EditorMode): number {
  const fen = toFen(l.price || 0);
  return isTotalMode(mode) ? fen : l.qty * fen;
}

export function linesTotal(lines: Line[], mode: EditorMode): number {
  return lines.reduce((s, l) => s + lineAmount(l, mode), 0);
}

/** 校验并转成接口需要的明细，失败时返回错误信息 */
export function linesToItems(lines: Line[], mode: EditorMode): { items?: any[]; error?: string } {
  if (!lines.length) return { error: '请至少添加一个商品' };
  if (lines.some((l) => !l.product && !l.catalog)) return { error: '还有未匹配商品的行，请选择或新建商品' };
  // 参考库行提交时由后端自动建档
  const ref = (l: Line) => (l.product ? { product_id: l.product.id } : { catalog_id: l.catalog!.id, barcode: l.barcode ?? undefined });
  if (mode === 'stocktake') return { items: lines.map((l) => ({ ...ref(l), counted_qty: l.counted ?? 0 })) };
  if (mode !== 'outbound' && lines.some((l) => l.price === '' || isNaN(Number(l.price))))
    return { error: isTotalMode(mode) ? '请填写每个商品的总价' : '请填写每个商品的单价' };
  return {
    items: lines.map((l) => ({
      ...ref(l),
      qty: l.qty,
      ...(isTotalMode(mode) ? { amount: toFen(l.price) } : { unit_price: mode === 'outbound' ? 0 : toFen(l.price) }),
      raw_name: l.raw_name,
    })),
  };
}

interface Props {
  mode: EditorMode;
  lines: Line[];
  onChange: (lines: Line[]) => void;
  autoScan?: boolean;
}

const PRICE_LABEL: Record<EditorMode, string> = {
  purchase: '总价',
  opening_stock: '成本',
  sale: '售价',
  outbound: '',
  stocktake: '',
};

export default function ItemsEditor({ mode, lines, onChange, autoScan }: Props) {
  const [picker, setPicker] = useState<{ lineKey?: string } | null>(null);
  const [scan, setScan] = useState(!!autoScan);
  const [bindCode, setBindCode] = useState<string | null>(null); // 扫到未登记条码，去找商品并绑定

  const addProduct = (p: Product, current: Line[] = lines) => {
    const hit = current.find((l) => l.product?.id === p.id);
    if (hit) {
      if (mode === 'stocktake') return current;
      return current.map((l) => (l === hit ? { ...l, qty: l.qty + 1 } : l));
    }
    return [
      ...current,
      { key: newKey(), product: p, qty: 1, price: defaultPrice(p, mode), counted: mode === 'stocktake' ? Math.max(p.stock_qty, 0) : undefined },
    ];
  };

  // 扫码时 lines 可能已被更新，用 ref 式的最新值
  const latest = { lines };
  const onScan = async (code: string) => {
    const r = await get<{ product: Product | null; catalog: CatalogItem | null }>(`/api/products/barcode/${encodeURIComponent(code)}`);
    // 扫到的是奥乐齐货号：直接从参考库建档
    const product = r.product ?? (r.catalog ? await catalogToProduct(r.catalog) : null);
    if (product) {
      const next = addProduct(product, latest.lines);
      latest.lines = next;
      onChange(next);
      Toast.show({ content: `${product.name} +1`, position: 'top' });
      return;
    }
    setScan(false);
    const ok = await Dialog.confirm({
      title: '条码未登记',
      content: `条码 ${code} 还没有对应的商品。去搜一下名称（含奥乐齐商品库），选中后会自动绑定这个条码。`,
      confirmText: '去找商品',
    });
    if (ok) setBindCode(code);
  };

  const update = (key: string, patch: Partial<Line>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: string) => onChange(lines.filter((l) => l.key !== key));
  const pickingLine = picker?.lineKey ? lines.find((l) => l.key === picker.lineKey) : undefined;
  const total = linesTotal(lines, mode);
  const qtyTotal = lines.reduce((s, l) => s + l.qty, 0);

  return (
    <div className="items-editor">
      {lines.map((l) => (
        <div className={`line-card ${l.product ? '' : 'line-unmatched'}`} key={l.key}>
          <div className="line-top">
            {l.product ? (
              <div className="line-name">
                <div>
                  {l.product.name}
                  {l.product.spec && <span className="muted"> · {l.product.spec}</span>}
                </div>
                {l.raw_name && l.raw_name !== l.product.name && <div className="line-raw">识别：{l.raw_name}</div>}
              </div>
            ) : l.catalog ? (
              <div className="line-name" onClick={() => setPicker({ lineKey: l.key })}>
                <div>
                  {l.catalog.name}
                  <span className="catalog-badge">{SOURCE_LABEL[l.catalog.source] ?? '参考库'} · 提交时建档</span>
                </div>
                {l.raw_name && <div className="line-raw">识别：{l.raw_name} · 不对点这里换</div>}
              </div>
            ) : (
              <div className="line-name" onClick={() => setPicker({ lineKey: l.key })}>
                <div className="warn-text">
                  <ExclamationCircleFill /> 未匹配：{l.raw_name}
                </div>
                <div className="line-raw">点这里选择或新建商品</div>
              </div>
            )}
            <div className="line-actions">
              {l.product && <StockTag qty={l.product.stock_qty} />}
              <DeleteOutline className="line-del" onClick={() => remove(l.key)} />
            </div>
          </div>
          {mode === 'stocktake' ? (
            <div className="line-row">
              <span className="muted">系统 {l.product?.stock_qty ?? 0}，实盘</span>
              <Stepper min={0} value={l.counted ?? 0} onChange={(v) => update(l.key, { counted: v })} />
              <span className={`diff ${(l.counted ?? 0) - (l.product?.stock_qty ?? 0) < 0 ? 'neg' : 'pos'}`}>
                差异 {(l.counted ?? 0) - (l.product?.stock_qty ?? 0) > 0 ? '+' : ''}
                {(l.counted ?? 0) - (l.product?.stock_qty ?? 0)}
              </span>
            </div>
          ) : (
            <div className="line-row">
              <Stepper min={1} value={l.qty} onChange={(v) => update(l.key, { qty: v || 1 })} />
              {mode !== 'outbound' && (
                <>
                  <div className="price-input">
                    <span>{PRICE_LABEL[mode]} ¥</span>
                    <Input type="number" inputMode="decimal" value={l.price} onChange={(v) => update(l.key, { price: v })} placeholder="0.00" />
                  </div>
                  {isTotalMode(mode) ? (
                    <span className="line-sub line-avg">
                      均 {money(Math.round(toFen(l.price || 0) / l.qty))}
                      {l.product?.last_cost != null && <small>之前 {money(l.product.last_cost)}</small>}
                    </span>
                  ) : (
                    <span className="line-sub">{money(l.qty * toFen(l.price || 0))}</span>
                  )}
                </>
              )}
              {mode === 'sale' && l.product?.avg_cost != null && (
                <span className="line-hint">均价 {money(l.product.avg_cost)}</span>
              )}
            </div>
          )}
        </div>
      ))}

      <div className="editor-buttons">
        <Button onClick={() => setScan(true)} color="primary" fill="outline">
          <ScanningOutline /> 扫码添加
        </Button>
        <Button onClick={() => setPicker({})} fill="outline">
          <AddOutline /> 选择商品
        </Button>
      </div>

      {mode !== 'stocktake' && lines.length > 0 && (
        <div className="editor-total">
          共 {lines.length} 种 {qtyTotal} 件{mode !== 'outbound' && <b>{money(total)}</b>}
        </div>
      )}

      <ProductPicker
        visible={!!picker}
        onClose={() => setPicker(null)}
        initialQuery={pickingLine?.raw_name ?? ''}
        candidates={pickingLine?.candidates}
        catalogCandidates={pickingLine?.catalogCandidates}
        newBarcode={pickingLine?.barcode}
        onPick={(p) => {
          if (pickingLine) {
            update(pickingLine.key, {
              product: p,
              catalog: null,
              price: pickingLine.price || defaultPrice(p, mode),
              counted: mode === 'stocktake' ? Math.max(p.stock_qty, 0) : undefined,
            });
          } else onChange(addProduct(p));
        }}
      />
      <Scanner
        visible={scan}
        continuous
        onClose={() => setScan(false)}
        onDetected={onScan}
        title={mode === 'stocktake' ? '扫码盘点' : '连续扫码'}
        hint="对准商品条码，扫到会自动 +1，同一件商品重复扫会累加"
      />
      <ProductPicker
        visible={bindCode != null}
        onClose={() => setBindCode(null)}
        bindBarcode={bindCode}
        onPick={(p) => onChange(addProduct(p))}
      />
    </div>
  );
}
