import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Checkbox, Input, List, NavBar, Stepper, TextArea, Toast } from 'antd-mobile';
import dayjs from 'dayjs';
import { get, money, post, toFen, toYuan, type Doc, type DocItem } from '../api';
import { useSession } from '../store';
import { DateField } from '../components/fields';

interface Line {
  item: DocItem;
  on: boolean;
  qty: number;
  refund: string;
  cost: string;
  /** 用户改过成本就不再跟着件数自动算 */
  costTouched: boolean;
}

const remainQty = (i: DocItem) => i.qty - (i.returned_qty ?? 0);
const remainRefund = (i: DocItem) => i.amount - (i.refunded ?? 0);
const defaultCost = (i: DocItem, qty: number) => toYuan((i.unit_cost ?? 0) * qty);

/**
 * 退货 / 退款：从原销售单发起。每行填退回件数（0 = 仅退款）、退款金额、退回入库成本，都带默认值可改。
 * ?replace=<退货单id>：确认一张淘宝导入的待处理退款（货退回来了），提交后替换掉它
 */
export default function ReturnPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const replaceId = Number(params.get('replace')) || undefined;
  const nav = useNavigate();
  const { refreshMeta } = useSession();
  const [sale, setSale] = useState<Doc | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [note, setNote] = useState('');
  /** 待处理退款里不关联商品的部分（没对上商品的退款），替换时原样带上 */
  const [extras, setExtras] = useState<{ name: string; amount: number }[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const s = (await get<{ doc: Doc }>(`/api/docs/${id}`)).doc;
      // 替换待处理退款时：它的退款额不算「已退」，并按它预填
      const pending = replaceId ? (await get<{ doc: Doc }>(`/api/docs/${replaceId}`)).doc : null;
      const prefill = new Map((pending?.items ?? []).map((x) => [x.ref_item_id, x]));
      if (pending) {
        for (const it of s.items!) {
          const p = prefill.get(it.id);
          if (p) {
            it.returned_qty = (it.returned_qty ?? 0) - p.qty;
            it.refunded = (it.refunded ?? 0) - p.amount;
          }
        }
        setNote(pending.note);
        setExtras((pending.adjustments ?? []).map((a) => ({ name: a.name, amount: a.amount })));
      }
      setSale(s);
      setLines(
        s.items!.map((item) => {
          const p = prefill.get(item.id);
          const on = pending ? !!p : false;
          const qty = on ? remainQty(item) : 0;
          return {
            item,
            on,
            qty,
            refund: toYuan(p ? p.amount : remainRefund(item)),
            cost: defaultCost(item, qty),
            costTouched: false,
          };
        }),
      );
    })().catch((e) => Toast.show(e.message));
  }, [id, replaceId]);

  if (!sale) return null;

  const update = (k: number, patch: Partial<Line>) =>
    setLines((ls) =>
      ls.map((l) => {
        if (l.item.id !== k) return l;
        const n = { ...l, ...patch };
        if (!n.costTouched) n.cost = defaultCost(n.item, n.qty);
        return n;
      }),
    );

  const toggle = (l: Line, on: boolean) =>
    update(l.item.id, on ? { on, qty: remainQty(l.item), refund: toYuan(remainRefund(l.item)) } : { on, qty: 0 });

  const picked = lines.filter((l) => l.on);
  const refundTotal = picked.reduce((s, l) => s + toFen(l.refund || 0), 0) + extras.reduce((s, e) => s + e.amount, 0);
  const costTotal = picked.reduce((s, l) => s + (l.qty ? toFen(l.cost || 0) : 0), 0);

  const submit = async () => {
    if (!picked.length && !extras.length) return void Toast.show('请勾选要退的商品');
    setSaving(true);
    try {
      const r = await post<{ doc: Doc }>(`/api/docs/${id}/return`, {
        items: picked.map((l) => ({
          ref_item_id: l.item.id,
          qty: l.qty,
          amount: toFen(l.refund || 0),
          in_cost: l.qty ? toFen(l.cost || 0) : undefined,
        })),
        extra: extras,
        doc_date: date,
        note,
        replace_doc_id: replaceId,
      });
      Toast.show({ content: '已记录', icon: 'success' });
      refreshMeta();
      nav(`/docs/${r.doc.id}`, { replace: true });
    } catch (e: any) {
      Toast.show({ content: e.message, icon: 'fail' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <NavBar onBack={() => nav(-1)}>{replaceId ? '确认退货' : '退货 / 退款'}</NavBar>
      <List>
        <List.Item extra={`${sale.doc_date} · ${money(sale.amount)}`}>{sale.source_ref ? `淘宝订单 ${sale.source_ref}` : '原销售单'}</List.Item>
        <List.Item extra={<DateField value={date} onChange={setDate} />}>退货日期</List.Item>
      </List>

      <div className="section-title">勾选要退的商品</div>
      {lines.map((l) => {
        const left = remainQty(l.item);
        return (
          <div key={l.item.id} className={`card return-line ${l.on ? 'on' : ''}`}>
            <Checkbox checked={l.on} onChange={(v) => toggle(l, v)}>
              <b>{l.item.product_name}</b>
            </Checkbox>
            <div className="muted small">
              卖出 {l.item.qty} 件 · {money(l.item.amount)}
              {l.item.returned_qty || l.item.refunded ? ` · 已退 ${l.item.returned_qty} 件 / ${money(l.item.refunded)}` : ''}
            </div>
            {l.on && (
              <div className="return-fields">
                <div className="return-field">
                  <span>货退回几件</span>
                  <Stepper min={0} max={left} value={l.qty} onChange={(v) => update(l.item.id, { qty: v })} />
                </div>
                {l.qty === 0 && <div className="muted small">0 件 = 仅退款，库存不变</div>}
                <div className="return-field">
                  <span>退款金额</span>
                  <Input type="number" inputMode="decimal" value={l.refund} onChange={(v) => update(l.item.id, { refund: v })} placeholder="0.00" />
                </div>
                {l.qty > 0 && (
                  <div className="return-field">
                    <span>退回入库成本</span>
                    <Input
                      type="number"
                      inputMode="decimal"
                      value={l.cost}
                      onChange={(v) => update(l.item.id, { cost: v, costTouched: true })}
                      placeholder="0.00"
                    />
                  </div>
                )}
                {l.qty > 0 && <div className="muted small">默认按卖出时的成本 {money(l.item.unit_cost ?? 0)}/件；坏了没法再卖可改成 0</div>}
              </div>
            )}
          </div>
        );
      })}

      {extras.length > 0 && (
        <List header="没对上商品的退款（只退钱）">
          {extras.map((e) => (
            <List.Item key={e.name} extra={money(e.amount)}>
              {e.name}
            </List.Item>
          ))}
        </List>
      )}

      <div className="card">
        <div className="kv-list">
          <div>
            <span>退给买家</span>
            <b>{money(refundTotal)}</b>
          </div>
          <div>
            <span>退回入库成本</span>
            <b>{money(costTotal)}</b>
          </div>
          <div className="kv-strong">
            <span>利润减少</span>
            <b className="down">{money(refundTotal - costTotal)}</b>
          </div>
          {sale.received === 0 && <div className="kv-sub">这单钱还没到账，退款先从淘宝应收里扣</div>}
        </div>
      </div>

      <List header="备注">
        <div style={{ padding: 12 }}>
          <TextArea value={note} onChange={setNote} placeholder="退货原因等" autoSize={{ minRows: 2 }} />
        </div>
      </List>

      <div style={{ padding: 16 }}>
        <Button block color="primary" loading={saving} onClick={submit}>
          {replaceId ? '确认并替换待处理退款' : '提交'}
        </Button>
      </div>
    </div>
  );
}
