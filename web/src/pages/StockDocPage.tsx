import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Dialog, Form, Input, NavBar, TextArea, Toast } from 'antd-mobile';
import dayjs from 'dayjs';
import { get, money, post, type CatalogItem, type Product, type Upload } from '../api';
import { useSession } from '../store';
import ItemsEditor, { defaultPrice, isTotalMode, linesToItems, linesTotal, newKey, type EditorMode, type Line } from '../components/ItemsEditor';
import ImagePicker from '../components/ImagePicker';
import AdjustmentsEditor, { adjustmentsToInput, adjustmentsTotal, type Adjustment } from '../components/AdjustmentsEditor';
import { AccountField, ChipField, DateField } from '../components/fields';

const TITLES: Record<string, string> = {
  purchase: '进货入库',
  sale: '销售出库',
  outbound: '其他出库',
  stocktake: '盘点',
};

interface RecognizeResult {
  date: string | null;
  store: string | null;
  buyer: string | null;
  channel: string | null;
  order_no: string | null;
  total: number | null;
  lines: {
    raw_name: string;
    barcode: string | null;
    qty: number;
    unit_price: number;
    product: Product | null;
    candidates: Product[];
    catalog: CatalogItem | null;
    catalog_candidates: CatalogItem[];
  }[];
}

export default function StockDocPage() {
  const { type = 'purchase' } = useParams();
  const mode = type as EditorMode;
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { meta, refreshMeta } = useSession();

  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [accountId, setAccountId] = useState<number>();
  // 销售默认第一个渠道（淘宝）
  const [channel, setChannel] = useState(mode === 'sale' ? (meta?.sale_channels[0] ?? '') : '');
  const [counterparty, setCounterparty] = useState('');
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [images, setImages] = useState<Upload[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [recognized, setRecognized] = useState<Set<number>>(new Set());
  const [recognizing, setRecognizing] = useState(false);
  const [receiptTotal, setReceiptTotal] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // 从商品详情点进来（?product=id）：直接带上这个商品，盘点就是只盘它
  const productId = params.get('product');
  useEffect(() => {
    if (!productId) return;
    get<{ product: Product }>(`/api/products/${productId}`)
      .then(({ product: p }) =>
        setLines([
          { key: newKey(), product: p, qty: 1, price: defaultPrice(p, mode), counted: mode === 'stocktake' ? Math.max(p.stock_qty, 0) : undefined },
        ]),
      )
      .catch((e) => Toast.show(e.message));
  }, [productId, mode]);

  const hasMoney = mode === 'purchase' || mode === 'sale';
  const canRecognize = hasMoney && meta?.vision_enabled;
  const goodsTotal = linesTotal(lines, mode);
  // 实付 = 商品合计 + 额外费用 − 减免（只有进货有）
  const payTotal = goodsTotal + (mode === 'purchase' ? adjustmentsTotal(adjustments) : 0);
  const imageKind = mode === 'purchase' ? 'receipt' : mode === 'sale' ? 'sale_shot' : 'other';

  const recognize = async (targets: Upload[]) => {
    if (!targets.length) return void Toast.show('请先上传图片');
    setRecognizing(true);
    let added: Line[] = [];
    let total = 0;
    try {
      for (const u of targets) {
        const r = await post<RecognizeResult>('/api/recognize', { upload_id: u.id, mode });
        if (r.date) setDate(r.date);
        if (mode === 'purchase' && r.store) setChannel((c) => c || r.store!);
        if (mode === 'sale' && r.buyer) setCounterparty((c) => c || r.buyer!);
        if (mode === 'sale' && r.channel && meta?.sale_channels.includes(r.channel)) setChannel(r.channel);
        if (r.order_no) setNote((n) => (n.includes(r.order_no!) ? n : `${n ? n + '\n' : ''}订单号 ${r.order_no}`));
        if (r.total) total += r.total;
        added = added.concat(
          r.lines.map((l) => ({
            key: newKey(),
            product: l.product,
            qty: l.qty,
            // 没识别出单价就留空，逼着手填，不默认成 0
            price: l.unit_price > 0 ? ((isTotalMode(mode) ? l.unit_price * l.qty : l.unit_price) / 100).toString() : '',
            raw_name: l.raw_name,
            barcode: l.barcode,
            candidates: l.candidates,
            catalog: l.catalog,
            catalogCandidates: l.catalog_candidates,
          })),
        );
        setRecognized((s) => new Set(s).add(u.id));
      }
      setLines((ls) => [...ls, ...added]);
      setReceiptTotal((t) => (total ? (t ?? 0) + total : t));
      const unmatched = added.filter((l) => !l.product && !l.catalog).length;
      const fromCatalog = added.filter((l) => !l.product && l.catalog).length;
      Toast.show({
        content: `识别出 ${added.length} 个商品${fromCatalog ? `，${fromCatalog} 个来自奥乐齐商品库` : ''}${unmatched ? `，${unmatched} 个需要手动匹配` : ''}`,
        icon: added.length ? 'success' : undefined,
        duration: 2500,
      });
    } catch (e: any) {
      Toast.show({ content: e.message, icon: 'fail', duration: 3000 });
    } finally {
      setRecognizing(false);
    }
  };

  const submit = async () => {
    const { items, error } = linesToItems(lines, mode);
    if (error) return void Toast.show(error);
    const adj = mode === 'purchase' ? adjustmentsToInput(adjustments) : {};
    if (adj.error) return void Toast.show(adj.error);
    if (payTotal < 0) return void Toast.show('减免不能超过应付金额');
    if (hasMoney && !accountId) return void Toast.show(mode === 'sale' ? '请选择收款账户' : '请选择付款账户');
    if (mode === 'outbound' && !category) return void Toast.show('请选择出库类型');
    const total = payTotal;
    const acc = meta?.accounts.find((a) => a.id === accountId);
    const ok = await Dialog.confirm({
      title: `确认提交${TITLES[mode]}`,
      content: (
        <div className="confirm-body">
          <div>{lines.length} 种商品，共 {lines.reduce((s, l) => s + l.qty, 0)} 件</div>
          {mode === 'purchase' && lines.some((l) => l.inQty != null && l.inQty < l.qty) && (
            <div className="warn-text">
              其中 {lines.reduce((s, l) => s + l.qty - (l.inQty ?? l.qty), 0)} 件不入库（不加库存，只记花的钱）
            </div>
          )}
          {hasMoney && (
            <div>
              {mode === 'sale' ? '收款' : '付款'}：<b>{acc?.name}</b> {money(total)}
            </div>
          )}
          {adj.adjustments?.length ? (
            <div className="muted small">
              含 {adj.adjustments.map((a) => `${a.name} ${money(a.amount, true)}`).join('，')}
            </div>
          ) : null}
          {receiptTotal != null && hasMoney && receiptTotal !== total && (
            <div className="warn-text">识别到的合计是 {money(receiptTotal)}，和明细合计不一致，请核对</div>
          )}
        </div>
      ),
    });
    if (!ok) return;
    setSaving(true);
    try {
      const r = await post('/api/docs', {
        type: mode,
        doc_date: date,
        account_id: accountId,
        channel,
        counterparty,
        category,
        note,
        items,
        adjustments: adj.adjustments,
        upload_ids: images.map((i) => i.id),
      });
      Toast.show({ content: '已提交', icon: 'success' });
      refreshMeta();
      nav(`/docs/${r.doc.id}`, { replace: true });
    } catch (e: any) {
      Toast.show({ content: e.message, icon: 'fail' });
    } finally {
      setSaving(false);
    }
  };

  const pending = images.filter((i) => !recognized.has(i.id));

  return (
    <div className="page">
      <NavBar onBack={() => nav(-1)}>{TITLES[mode]}</NavBar>
      <Form layout="horizontal" mode="card">
        {mode !== 'stocktake' && (
          <Form.Item label="日期">
            <DateField value={date} onChange={setDate} />
          </Form.Item>
        )}
        {mode === 'purchase' && (
          <Form.Item label="渠道">
            <Input value={channel} onChange={setChannel} placeholder="例如 山姆滨江店 / ALDI" clearable />
          </Form.Item>
        )}
        {mode === 'sale' && (
          <>
            <Form.Item label="渠道" layout="vertical">
              <ChipField options={meta?.sale_channels ?? []} value={channel} onChange={setChannel} />
            </Form.Item>
            <Form.Item label="买家">
              <Input value={counterparty} onChange={setCounterparty} placeholder="可不填" clearable />
            </Form.Item>
          </>
        )}
        {mode === 'outbound' && (
          <Form.Item label="出库类型" layout="vertical">
            <ChipField options={meta?.outbound_categories ?? []} value={category} onChange={setCategory} />
          </Form.Item>
        )}
        {hasMoney && (
          <Form.Item label={mode === 'sale' ? '钱进了谁的账户' : '谁付的钱'} layout="vertical">
            <AccountField value={accountId} onChange={setAccountId} />
          </Form.Item>
        )}
        {mode !== 'stocktake' && (
          <Form.Item
            label={mode === 'purchase' ? '小票' : mode === 'sale' ? '卖货截图' : '照片'}
            layout="vertical"
            description={canRecognize ? '上传后可以让 AI 识别并自动填好商品明细' : undefined}
          >
            <ImagePicker kind={imageKind} value={images} onChange={setImages} label={mode === 'purchase' ? '拍小票' : '上传'} />
            {canRecognize && images.length > 0 && (
              <Button
                className="recognize-btn"
                block
                color="primary"
                fill={pending.length ? 'solid' : 'outline'}
                loading={recognizing}
                loadingText="识别中…"
                disabled={!pending.length}
                onClick={() => recognize(pending)}
              >
                ✨ {pending.length ? `AI 识别${pending.length > 1 ? ` ${pending.length} 张图` : ''}并填充` : '已识别'}
              </Button>
            )}
          </Form.Item>
        )}
      </Form>

      <div className="section-title">
        商品明细
        {receiptTotal != null && hasMoney && (
          <span className={receiptTotal === payTotal ? 'ok-text' : 'warn-text'}>
            识别合计 {money(receiptTotal)}
            {receiptTotal === payTotal ? ' ✓' : ''}
          </span>
        )}
      </div>
      <ItemsEditor mode={mode} lines={lines} onChange={setLines} autoScan={params.get('scan') === '1'} />

      {mode === 'purchase' && (
        <>
          <div className="section-title">额外费用 / 减免</div>
          <AdjustmentsEditor value={adjustments} onChange={setAdjustments} goodsTotal={goodsTotal} />
        </>
      )}

      <Form layout="horizontal" mode="card">
        <Form.Item label="备注">
          <TextArea value={note} onChange={setNote} autoSize={{ minRows: 1, maxRows: 4 }} placeholder="可不填" />
        </Form.Item>
      </Form>

      <div className="submit-bar">
        {hasMoney && <span className="submit-total">{money(payTotal)}</span>}
        <Button color="primary" size="large" loading={saving} onClick={submit} style={{ flex: 1 }}>
          确认提交
        </Button>
      </div>
    </div>
  );
}
