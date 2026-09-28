import { useState } from 'react';
import { Button, List, Stepper, Toast } from 'antd-mobile';
import type { Product } from '../api';
import ProductPicker from './ProductPicker';

export interface PickedProduct {
  product_id: number;
  qty: number;
  name: string;
  spec?: string;
  stock_qty?: number;
}

/** 选若干商品和件数：SKU 对照（套装多个商品）、实发核对共用 */
export default function ProductsEditor({
  title,
  hint,
  initial,
  onSave,
  extra,
  onClose,
  allowEmpty,
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
  saveText?: string;
}) {
  const [items, setItems] = useState<PickedProduct[]>(initial);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);

  const add = (p: Product) => {
    setItems((xs) =>
      xs.some((x) => x.product_id === p.id)
        ? xs.map((x) => (x.product_id === p.id ? { ...x, qty: x.qty + 1 } : x))
        : [...xs, { product_id: p.id, qty: 1, name: p.name, spec: p.spec, stock_qty: p.stock_qty }],
    );
    setPicking(false);
  };

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
          </List.Item>
        ))}
      </List>
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
