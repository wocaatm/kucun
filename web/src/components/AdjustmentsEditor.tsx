import { Button, Input } from 'antd-mobile';
import { AddOutline, DeleteOutline } from 'antd-mobile-icons';
import { money, toFen } from '../api';

/** 进货单上的额外费用 / 减免：影响实付，不影响商品均价 */
export interface Adjustment {
  key: string;
  sign: 1 | -1; // 1 额外费用，-1 减免
  name: string;
  price: string; // 元，正数
}

const FEE_NAMES = ['运费', '包装费', '手续费'];
const DISCOUNT_NAMES = ['优惠券', '满减', '红包'];

let seq = 0;

export function adjustmentsTotal(list: Adjustment[]): number {
  return list.reduce((s, a) => s + a.sign * toFen(a.price || 0), 0);
}

/** 校验并转成接口需要的格式（金额带符号，分） */
export function adjustmentsToInput(list: Adjustment[]): { adjustments?: { name: string; amount: number }[]; error?: string } {
  const filled = list.filter((a) => a.name.trim() || a.price !== '');
  for (const a of filled) {
    if (!a.name.trim()) return { error: '费用 / 减免项请填写名称' };
    const n = Number(a.price);
    if (a.price === '' || isNaN(n) || n <= 0) return { error: `请填写「${a.name.trim()}」的金额` };
  }
  return { adjustments: filled.map((a) => ({ name: a.name.trim(), amount: a.sign * toFen(a.price) })) };
}

export default function AdjustmentsEditor({
  value,
  onChange,
  goodsTotal,
}: {
  value: Adjustment[];
  onChange: (v: Adjustment[]) => void;
  goodsTotal: number;
}) {
  const add = (sign: 1 | -1) => {
    const used = new Set(value.map((a) => a.name));
    const name = (sign > 0 ? FEE_NAMES : DISCOUNT_NAMES).find((n) => !used.has(n)) ?? '';
    onChange([...value, { key: `a${++seq}`, sign, name, price: '' }]);
  };
  const update = (key: string, patch: Partial<Adjustment>) => onChange(value.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  const fees = value.filter((a) => a.sign > 0).reduce((s, a) => s + toFen(a.price || 0), 0);
  const discounts = value.filter((a) => a.sign < 0).reduce((s, a) => s + toFen(a.price || 0), 0);

  return (
    <div className="adj-editor">
      {value.map((a) => (
        <div className="adj-row" key={a.key}>
          <span className={`adj-tag ${a.sign > 0 ? 'fee' : 'discount'}`}>{a.sign > 0 ? '费用' : '减免'}</span>
          <Input
            className="adj-name"
            value={a.name}
            onChange={(v) => update(a.key, { name: v })}
            placeholder={a.sign > 0 ? '例如 运费' : '例如 优惠券'}
          />
          <div className="price-input">
            <span>{a.sign > 0 ? '+' : '−'} ¥</span>
            <Input type="number" inputMode="decimal" value={a.price} onChange={(v) => update(a.key, { price: v })} placeholder="0.00" />
          </div>
          <DeleteOutline className="line-del" onClick={() => onChange(value.filter((x) => x.key !== a.key))} />
        </div>
      ))}
      <div className="editor-buttons">
        <Button fill="outline" onClick={() => add(1)}>
          <AddOutline /> 额外费用
        </Button>
        <Button fill="outline" onClick={() => add(-1)}>
          <AddOutline /> 减免
        </Button>
      </div>
      {value.length > 0 && (
        <div className="editor-total">
          商品 {money(goodsTotal)}
          {fees > 0 && ` + 费用 ${money(fees)}`}
          {discounts > 0 && ` − 减免 ${money(discounts)}`}
          <b>实付 {money(goodsTotal + fees - discounts)}</b>
        </div>
      )}
      <div className="adj-hint muted small">运费、优惠券按商品金额比例摊进这单每个商品的成本（进价 = 实付）</div>
    </div>
  );
}
