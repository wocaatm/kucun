import { useState } from 'react';
import { Button, List, Stepper, Toast } from 'antd-mobile';
import type { Product } from '../api';
import ProductPicker from './ProductPicker';

export interface PickedProduct {
  /** 奥乐齐参考库里还没建档的候选用负数占位，保存时按 catalog_id 建档 */
  product_id: number;
  catalog_id?: number;
  qty: number;
  name: string;
  spec?: string;
  stock_qty?: number | null;
}

/** 系统给的候选（按相似度排好），由人挑 */
export interface Suggestion {
  product_id?: number;
  catalog_id?: number;
  name: string;
  spec: string;
  stock_qty: number | null;
  score: number;
}

/** 提交给服务端的商品：库存商品给 product_id，参考库候选给 catalog_id */
export const pickedToInput = (items: PickedProduct[]) =>
  items.map((i) => (i.catalog_id ? { catalog_id: i.catalog_id, qty: i.qty } : { product_id: i.product_id, qty: i.qty }));

/** 选若干商品和件数：SKU 对照（套装多个商品）、实发核对共用 */
export default function ProductsEditor({
  title,
  hint,
  initial,
  onSave,
  extra,
  onClose,
  allowEmpty,
  suggestions = [],
  saveText = '保存并确认',
}: {
  title: string;
  hint?: React.ReactNode;
  initial: PickedProduct[];
  onSave: (items: PickedProduct[]) => Promise<void>;
  extra?: React.ReactNode;
  onClose: () => void;
  /** 允许一个商品都不选（如刷单空包） */
  allowEmpty?: boolean;
  suggestions?: Suggestion[];
  saveText?: string;
}) {
  const [items, setItems] = useState<PickedProduct[]>(initial);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);

  const addPicked = (p: PickedProduct) =>
    setItems((xs) =>
      xs.some((x) => x.product_id === p.product_id)
        ? xs.map((x) => (x.product_id === p.product_id ? { ...x, qty: x.qty + 1 } : x))
        : [...xs, p],
    );
  const add = (p: Product) => {
    addPicked({ product_id: p.id, qty: 1, name: p.name, spec: p.spec, stock_qty: p.stock_qty });
    setPicking(false);
  };
  const fromSuggestion = (s: Suggestion): PickedProduct =>
    s.product_id
      ? { product_id: s.product_id, qty: 1, name: s.name, spec: s.spec, stock_qty: s.stock_qty }
      : { product_id: -s.catalog_id!, catalog_id: s.catalog_id, qty: 1, name: s.name, spec: s.spec, stock_qty: null };
  const shown = suggestions.filter((s) => !items.some((x) => x.product_id === (s.product_id ?? -s.catalog_id!)));

  const save = async () => {
    if (!items.length && !allowEmpty) return void Toast.show('至少选一个商品');
    setSaving(true);
    try {
      await onSave(items);
      onClose();
    } catch (e: any) {
      Toast.show({ content: e.message, icon: 'fail' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="tb-editor">
      <div className="tb-editor-title">{title}</div>
      {hint && <div className="muted small">{hint}</div>}
      <List>
        {items.map((it) => (
          <List.Item
            key={it.product_id}
            description={it.spec}
            extra={
              <div className="tb-qty">
                <Stepper
                  min={1}
                  value={it.qty}
                  onChange={(v) => setItems((xs) => xs.map((x) => (x.product_id === it.product_id ? { ...x, qty: v || 1 } : x)))}
                />
                <a className="danger-link" onClick={() => setItems((xs) => xs.filter((x) => x.product_id !== it.product_id))}>
                  删
                </a>
              </div>
            }
          >
            {it.name}
            {it.catalog_id ? <span className="muted small">（保存时新建）</span> : null}
          </List.Item>
        ))}
      </List>
      {shown.length > 0 && (
        <List header="系统建议（按相似度排，点一下加入；不对就别选，自己添加）">
          {shown.map((s) => (
            <List.Item
              key={s.product_id ?? `c${s.catalog_id}`}
              onClick={() => addPicked(fromSuggestion(s))}
              description={[
                s.spec,
                s.product_id ? `库存 ${s.stock_qty}` : '奥乐齐商品库里的，选了会新建商品',
              ]
                .filter(Boolean)
                .join(' · ')}
              extra={<span className={s.score >= 0.75 ? 'up' : 'muted'}>像 {Math.round(s.score * 100)}%</span>}
            >
              + {s.name}
            </List.Item>
          ))}
        </List>
      )}
      <Button block fill="outline" onClick={() => setPicking(true)} style={{ marginTop: 8 }}>
        + 添加商品
      </Button>
      {extra}
      <Button block color="primary" loading={saving} onClick={save} style={{ marginTop: 12 }}>
        {saveText}
      </Button>
      <ProductPicker visible={picking} onClose={() => setPicking(false)} onPick={add} />
    </div>
  );
}
