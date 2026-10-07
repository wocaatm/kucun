import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Dialog, Input, List, NavBar, Selector, Tag, TextArea, Toast } from 'antd-mobile';
import { api, docMoneySign, get, money, post, type Doc, type Upload } from '../api';
import { useSession } from '../store';
import ImagePicker from '../components/ImagePicker';
import { DateField } from '../components/fields';
import { docTitle } from './Docs';

export default function DocDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { meta, refreshMeta } = useSession();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    get<{ doc: Doc }>(`/api/docs/${id}`).then((r) => {
      setDoc(r.doc);
      setNote(r.doc.note);
    });
  }, [id]);

  if (!doc) return null;

  const saveNote = async () => {
    const r = await api<{ doc: Doc }>('PATCH', `/api/docs/${id}`, { note });
    setDoc(r.doc);
    setEditing(false);
    Toast.show('已保存');
  };

  const addImages = async (list: Upload[]) => {
    const fresh = list.filter((u) => !doc.uploads!.some((x) => x.id === u.id));
    if (!fresh.length) return;
    const r = await api<{ doc: Doc }>('PATCH', `/api/docs/${id}`, { upload_ids: fresh.map((u) => u.id) });
    setDoc(r.doc);
  };

  const voidIt = async () => {
    let reason = '';
    const ok = await Dialog.confirm({
      title: '作废这张单据？',
      content: (
        <div>
          <div className="muted small" style={{ marginBottom: 8 }}>
            作废后库存和账户余额会自动回滚，记录保留可查。如果是录错了，作废后重新录一张。
          </div>
          <Input placeholder="作废原因（必填）" onChange={(v) => (reason = v)} />
        </div>
      ),
      confirmText: '作废',
    });
    if (!ok) return;
    try {
      const r = await post<{ doc: Doc }>(`/api/docs/${id}/void`, { reason });
      setDoc(r.doc);
      refreshMeta();
      Toast.show('已作废');
    } catch (e: any) {
      Toast.show({ content: e.message, icon: 'fail' });
    }
  };

  const patch = async (body: Record<string, unknown>) => {
    try {
      const r = await api<{ doc: Doc }>('PATCH', `/api/docs/${id}`, body);
      setDoc(r.doc);
      refreshMeta();
      Toast.show('已保存');
    } catch (e: any) {
      Toast.show({ content: e.message, icon: 'fail' });
    }
  };

  const refundOnly = async () => {
    const ok = await Dialog.confirm({
      title: '确认只退了钱？',
      content: '货没有退回来：库存不变，这笔退款照常冲减销售额。',
      confirmText: '确认仅退款',
    });
    if (!ok) return;
    const r = await post<{ doc: Doc }>(`/api/docs/${id}/refund-only`);
    setDoc(r.doc);
    Toast.show('已确认');
  };

  const sign = docMoneySign(doc);
  const isStock = ['purchase', 'sale', 'sale_return', 'outbound', 'stocktake', 'opening_stock'].includes(doc.type);
  const returnable =
    doc.type === 'sale' && doc.status === 'active' && doc.items!.some((i) => (i.returned_qty ?? 0) < i.qty || (i.refunded ?? 0) < i.amount);
  const tb = doc.taobao_order;
  const totalCost = doc.items?.reduce((s, i) => s + i.cost_amount, 0) ?? 0;
  const pending = doc.items?.reduce((s, i) => s + i.cost_pending, 0) ?? 0;

  return (
    <div className="page">
      <NavBar onBack={() => nav(-1)}>单据详情</NavBar>
      <div className={`card doc-head ${doc.status === 'void' ? 'is-void' : ''}`}>
        <div className="doc-type">
          {docTitle(doc)}
          {doc.status === 'void' && <Tag color="default">已作废</Tag>}
        </div>
        {(sign !== 0 || doc.type === 'transfer') && (
          <div className={`doc-amount ${sign > 0 ? 'up' : sign < 0 ? 'down' : ''}`}>
            {doc.type === 'transfer' ? money(doc.amount) : money(sign, true)}
          </div>
        )}
        {doc.status === 'void' && (
          <div className="warn-text small">
            {doc.voided_by_name} 于 {doc.voided_at} 作废：{doc.void_reason}
          </div>
        )}
      </div>

      <List>
        <List.Item
          extra={
            doc.status === 'active' && doc.source !== 'taobao' ? (
              <DateField value={doc.doc_date} onChange={(v) => patch({ doc_date: v })} />
            ) : (
              doc.doc_date
            )
          }
        >
          日期
        </List.Item>
        {(doc.type === 'expense' || doc.type === 'income') && doc.status === 'active' && (
          <div className="doc-cat-edit">
            <div className="muted small">分类</div>
            <Selector
              columns={3}
              options={((doc.type === 'expense' ? meta?.expense_categories : meta?.income_categories) ?? []).map((c) => ({ label: c, value: c }))}
              value={[doc.category]}
              onChange={(v) => v[0] && v[0] !== doc.category && patch({ category: v[0] })}
            />
          </div>
        )}
        {doc.type === 'transfer' ? (
          <List.Item extra={`${doc.account_name} → ${doc.to_account_name}`}>转账</List.Item>
        ) : (
          doc.account_name && <List.Item extra={doc.account_name}>{sign >= 0 ? '收款账户' : '付款账户'}</List.Item>
        )}
        {doc.channel && <List.Item extra={doc.channel}>渠道</List.Item>}
        {doc.source_ref && <List.Item extra={doc.source_ref}>淘宝订单号</List.Item>}
        {tb && doc.type === 'sale' && (
          <List.Item
            extra={
              doc.received === 0 ? (
                <Tag color="warning" fill="outline">待买家确认收货</Tag>
              ) : (
                `已到账 ${doc.received_at?.slice(0, 10) ?? ''}`
              )
            }
            description={`淘宝状态：${tb.status}${tb.shipped_at ? ` · 发货 ${tb.shipped_at.slice(0, 16)}` : ''}`}
          >
            到账
          </List.Item>
        )}
        {doc.ref_doc && (
          <List.Item onClick={() => nav(`/docs/${doc.ref_doc!.id}`)} arrow extra={`${doc.ref_doc.doc_date} · ${money(doc.ref_doc.amount)}`}>
            原销售单
          </List.Item>
        )}
        {doc.counterparty && <List.Item extra={doc.counterparty}>买家</List.Item>}
        <List.Item extra={`${doc.created_by_name} · ${doc.created_at.slice(0, 16)}`}>录入</List.Item>
        {doc.type === 'sale' && doc.items!.length > 0 && (
          <List.Item extra={pending ? `${money(totalCost)}（${pending} 件待定）` : money(totalCost)}>结转成本</List.Item>
        )}
        {doc.type === 'sale' && doc.items!.length > 0 && <List.Item extra={money(doc.amount - totalCost)}>本单毛利</List.Item>}
        {doc.type === 'sale_return' && (
          <List.Item extra={<span className="down">-{money(doc.amount - totalCost)}</span>} description="退款 − 退回入库的成本">
            利润减少
          </List.Item>
        )}
      </List>

      {doc.review === 'unmatched' && doc.status === 'active' && (
        <div className="card pending-card">
          <div className="warn-text">
            这单有商品没对上：{doc.adjustments!.filter((x) => x.name.startsWith('未匹配') || x.name.startsWith('待核对')).map((x) => x.name).join('、')}。
            这部分只记了金额，没扣库存、没算成本。
          </div>
          <Button size="small" color="primary" onClick={() => nav(`/taobao/orders/${doc.source_ref}`)}>
            去看订单 / 核对实发
          </Button>
        </div>
      )}

      {doc.review === 'pending' && doc.status === 'active' && (
        <div className="card pending-card">
          <div className="warn-text">淘宝导入自动生成的退款，默认按「仅退款、货没退回」记账。货收到了吗？</div>
          <div className="btn-row">
            <Button size="small" color="primary" onClick={() => nav(`/docs/${doc.ref_doc_id}/return?replace=${doc.id}`)}>
              货退回来了
            </Button>
            <Button size="small" fill="outline" onClick={refundOnly}>
              没退货，仅退款
            </Button>
          </div>
        </div>
      )}

      {isStock && doc.items!.length > 0 && (
        <List header="商品明细">
          {doc.items!.map((i) => (
            <List.Item
              key={i.id}
              onClick={() => nav(`/products/${i.product_id}`)}
              description={
                doc.type === 'stocktake'
                  ? i.qty === 0
                    ? `实盘 ${i.counted_qty}，无差异`
                    : `实盘 ${i.counted_qty}，差异 ${i.qty > 0 ? '+' : ''}${i.qty}，${i.qty < 0 ? '损耗' : '盘盈'} ${money(i.cost_amount)}`
                  : [
                      i.spec,
                      i.raw_name && i.raw_name !== i.product_name ? `识别：${i.raw_name}` : '',
                      doc.type === 'purchase' && i.buy_qty != null
                        ? `买 ${i.buy_qty} 件，入库 ${i.qty} 件，其余只记钱 · 均价 ${money(i.unit_price)}`
                        : doc.type === 'purchase'
                        ? i.in_cost != null && i.in_cost !== i.amount
                          ? `标价 ${money(i.amount)} → 实付 ${money(i.in_cost)}（${money(Math.round(i.in_cost / i.qty))}/件）`
                          : `均价 ${money(i.unit_price)}`
                        : '',
                      doc.type === 'sale' ? `成本 ${i.cost_pending ? '待定' : money(i.cost_amount)}` : '',
                      doc.type === 'sale' && (i.returned_qty || i.refunded)
                        ? `已退 ${i.returned_qty} 件 / ${money(i.refunded)}`
                        : '',
                      doc.type === 'sale_return' ? (i.qty ? `退回 ${i.qty} 件，入库成本 ${money(i.cost_amount)}` : '仅退款，货未退回') : '',
                      doc.type === 'outbound' ? `成本 ${money(i.cost_amount)}` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')
              }
              extra={
                doc.type === 'stocktake'
                  ? null
                  : doc.type === 'outbound'
                    ? `×${i.qty}`
                    : doc.type === 'purchase' || doc.type === 'sale_return'
                      ? `${doc.type === 'purchase' ? `×${i.buy_qty ?? i.qty} 共 ` : '退 '}${money(i.amount)}`
                      : `${money(i.unit_price)} × ${i.qty}`
              }
            >
              {i.product_name}
            </List.Item>
          ))}
        </List>
      )}

      {doc.adjustments && doc.adjustments.length > 0 && (
        <List header={doc.type === 'sale' ? '商品以外的金额' : doc.type === 'sale_return' ? '其他退款' : '额外费用 / 减免'}>
          <List.Item extra={money(doc.items!.reduce((s, i) => s + i.amount, 0))}>商品合计</List.Item>
          {doc.adjustments.map((a) => (
            <List.Item
              key={a.id}
              extra={<span className={(a.amount > 0) === (doc.type === 'sale') ? 'up' : 'down'}>{money(a.amount, true)}</span>}
            >
              {a.name}
              <span className="muted small">
                {doc.type === 'sale_return' ? ' · 不关联商品' : doc.type === 'sale' ? ' · 计入销售额' : a.amount > 0 ? ' · 费用' : ' · 减免'}
              </span>
            </List.Item>
          ))}
          <List.Item extra={<b>{money(doc.amount)}</b>}>{doc.type === 'sale' ? '买家实付' : doc.type === 'sale_return' ? '退款合计' : '实付'}</List.Item>
        </List>
      )}

      {doc.returns && doc.returns.length > 0 && (
        <List header="退货退款记录">
          {doc.returns.map((r) => (
            <List.Item key={r.id} arrow onClick={() => nav(`/docs/${r.id}`)} extra={<span className={r.status === 'void' ? 'voided' : 'down'}>-{money(r.amount)}</span>}>
              {r.doc_date}
              {r.status === 'void' && <Tag color="default" style={{ marginLeft: 6 }}>已作废</Tag>}
              {r.status === 'active' && r.review === 'pending' && <Tag color="danger" fill="outline" style={{ marginLeft: 6 }}>待确认</Tag>}
            </List.Item>
          ))}
        </List>
      )}

      {doc.type === 'sale' && doc.source === 'taobao' && doc.status === 'active' && (
        <div style={{ padding: '12px 16px 0' }}>
          <Button block fill="outline" onClick={() => nav(`/taobao/orders/${doc.source_ref}`)}>
            淘宝订单 · 改实发商品（刷单空包、改发别的）
          </Button>
        </div>
      )}

      {returnable && (
        <div style={{ padding: '12px 16px 0' }}>
          <Button block color="primary" fill="outline" onClick={() => nav(`/docs/${doc.id}/return`)}>
            退货 / 退款
          </Button>
        </div>
      )}

      <List header="备注">
        {editing ? (
          <div style={{ padding: 12 }}>
            <TextArea value={note} onChange={setNote} autoSize={{ minRows: 2 }} />
            <Button size="small" color="primary" onClick={saveNote} style={{ marginTop: 8 }}>
              保存
            </Button>
          </div>
        ) : (
          <List.Item onClick={() => setEditing(true)} arrow>
            {doc.note || <span className="muted">添加备注</span>}
          </List.Item>
        )}
      </List>

      <div className="section-title">图片</div>
      <div className="card">
        <ImagePicker kind={doc.type === 'sale' ? 'sale_shot' : doc.type === 'purchase' ? 'receipt' : 'expense'} value={doc.uploads!} onChange={addImages} deletable={false} />
      </div>

      {doc.status === 'active' && doc.source === 'taobao' && (
        <div className="muted small" style={{ padding: 16 }}>
          淘宝导入的单据由每天的导入维护，不能手动作废；退款请用上面的「退货 / 退款」。
        </div>
      )}
      {doc.status === 'active' && doc.source !== 'taobao' && (
        <div style={{ padding: 16 }}>
          <Button block color="danger" fill="outline" onClick={voidIt}>
            作废这张单据
          </Button>
        </div>
      )}
    </div>
  );
}
