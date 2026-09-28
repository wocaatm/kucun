import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CapsuleTabs, Dialog, Empty, Image, InfiniteScroll, List, NavBar, SearchBar, Selector, Tabs, Tag, TextArea, Toast } from 'antd-mobile';
import { DOC_LABEL, api, docMoneySign, fileUrl, get, money, UPLOAD_KIND_LABEL, type Doc, type Upload } from '../api';
import { useSession } from '../store';

const TYPE_FILTERS = [
  { key: '', title: '全部' },
  { key: 'purchase,opening_stock', title: '进货' },
  { key: 'sale,sale_return', title: '销售' },
  { key: 'outbound,stocktake', title: '出库盘点' },
  { key: 'expense', title: '支出' },
  { key: 'income,transfer,opening_balance', title: '收入转账' },
];

const TYPE_ICON: Record<string, string> = {
  purchase: '📦',
  sale: '🛍️',
  sale_return: '↩️',
  outbound: '🎁',
  stocktake: '📋',
  opening_stock: '🏁',
  expense: '💸',
  income: '💰',
  transfer: '🔁',
  opening_balance: '🏁',
};

export function docTitle(d: Doc) {
  if (d.type === 'sale' && d.amount < 0) return '销售退款';
  if (d.type === 'sale' && d.source === 'taobao') return '淘宝销售';
  return `${DOC_LABEL[d.type]}${d.category ? ` · ${d.category}` : ''}`;
}

function DocList() {
  const nav = useNavigate();
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Doc[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const gen = useRef(0);

  useEffect(() => {
    gen.current++;
    setItems([]);
    setHasMore(true);
  }, [type, q]);

  const loadMore = async () => {
    const g = gen.current;
    const r = await get<{ items: Doc[] }>(
      `/api/docs?type=${type}&q=${encodeURIComponent(q)}&offset=${items.length}&limit=30`,
    );
    if (g !== gen.current) return;
    setItems((x) => [...x, ...r.items]);
    setHasMore(r.items.length === 30);
  };

  return (
    <>
      <CapsuleTabs activeKey={type} onChange={setType}>
        {TYPE_FILTERS.map((f) => (
          <CapsuleTabs.Tab key={f.key} title={f.title} />
        ))}
      </CapsuleTabs>
      <div className="doc-search">
        <SearchBar placeholder="搜淘宝订单号 / 备注" onSearch={setQ} onClear={() => setQ('')} />
      </div>
      <List>
        {items.map((d) => {
          const sign = docMoneySign(d);
          const acct =
            d.type === 'transfer' ? `${d.account_name} → ${d.to_account_name}` : d.account_name ? d.account_name : '';
          return (
            <List.Item
              key={d.id}
              onClick={() => nav(`/docs/${d.id}`)}
              prefix={<span className="doc-icon">{TYPE_ICON[d.type]}</span>}
              description={
                <>
                  <div className="ellipsis">{d.item_summary || d.note || d.channel || '—'}</div>
                  <div>
                    {d.doc_date} · {d.created_by_name}
                    {acct ? ` · ${acct}` : ''}
                    {d.upload_count ? ` · 📷${d.upload_count}` : ''}
                  </div>
                </>
              }
              extra={
                <span className={d.status === 'void' ? 'voided' : sign > 0 ? 'up' : sign < 0 ? 'down' : ''}>
                  {d.type === 'transfer' ? money(d.amount) : sign !== 0 ? money(sign, true) : ''}
                </span>
              }
            >
              {docTitle(d)}
              {d.status === 'void' && (
                <Tag color="default" style={{ marginLeft: 6 }}>
                  已作废
                </Tag>
              )}
              {d.status === 'active' && d.type === 'sale' && d.received === 0 && (
                <Tag color="warning" fill="outline" style={{ marginLeft: 6 }}>
                  待到账
                </Tag>
              )}
              {d.status === 'active' && d.review === 'pending' && (
                <Tag color="danger" fill="outline" style={{ marginLeft: 6 }}>
                  待确认
                </Tag>
              )}
            </List.Item>
          );
        })}
      </List>
      {!hasMore && !items.length && <Empty description="还没有记录" />}
      <InfiniteScroll loadMore={loadMore} hasMore={hasMore}>
        {hasMore ? '加载中…' : items.length ? '没有更多了' : ''}
      </InfiniteScroll>
    </>
  );
}

function Album() {
  const nav = useNavigate();
  const { meta } = useSession();
  const [kind, setKind] = useState('');
  const [user, setUser] = useState('');
  const [items, setItems] = useState<Upload[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const gen = useRef(0);

  useEffect(() => {
    gen.current++;
    setItems([]);
    setHasMore(true);
  }, [kind, user]);

  const loadMore = async () => {
    const g = gen.current;
    const r = await get<{ items: Upload[] }>(`/api/uploads?kind=${kind}&user=${user}&offset=${items.length}&limit=30`);
    if (g !== gen.current) return;
    setItems((x) => [...x, ...r.items]);
    setHasMore(r.items.length === 30);
  };

  const open = (u: Upload) => {
    let note = u.note;
    Dialog.show({
      closeOnMaskClick: true,
      content: (
        <div className="album-detail">
          <Image src={fileUrl(u.id)} fit="contain" style={{ maxHeight: '50vh', borderRadius: 8 }} />
          <div className="muted small">
            {UPLOAD_KIND_LABEL[u.kind] ?? u.kind} · {u.created_by_name} · {u.created_at.slice(0, 16)}
          </div>
          {u.doc_type && (
            <div className="small">
              所属单据：{DOC_LABEL[u.doc_type as keyof typeof DOC_LABEL]}
              {u.doc_category ? ` · ${u.doc_category}` : ''} {money(u.doc_amount)} {u.doc_status === 'void' ? '（已作废）' : ''}
              {u.doc_note ? <div className="muted">单据备注：{u.doc_note}</div> : null}
            </div>
          )}
          <TextArea defaultValue={u.note} placeholder="给这张图写个备注" autoSize={{ minRows: 2 }} onChange={(v) => (note = v)} />
        </div>
      ),
      actions: [
        [
          { key: 'orig', text: '看原图', onClick: () => void window.open(fileUrl(u.id, true)) },
          ...(u.doc_id ? [{ key: 'doc', text: '查看单据', onClick: () => nav(`/docs/${u.doc_id}`) }] : []),
        ],
        {
          key: 'save',
          text: '保存备注',
          bold: true,
          onClick: async () => {
            await api('PATCH', `/api/uploads/${u.id}`, { note });
            setItems((xs) => xs.map((x) => (x.id === u.id ? { ...x, note } : x)));
            Toast.show('已保存');
          },
        },
      ],
    });
  };

  return (
    <>
      <div className="album-filters">
        <Selector
          columns={5}
          options={[{ label: '全部', value: '' }, ...Object.entries(UPLOAD_KIND_LABEL).map(([value, label]) => ({ label, value }))]}
          value={[kind]}
          onChange={(v) => setKind(v[0] ?? '')}
        />
        <Selector
          columns={5}
          options={[{ label: '所有人', value: '' }, ...(meta?.users ?? []).map((u) => ({ label: u.name, value: String(u.id) }))]}
          value={[user]}
          onChange={(v) => setUser(v[0] ?? '')}
        />
      </div>
      <div className="album-grid">
        {items.map((u) => (
          <div key={u.id} className="album-cell" onClick={() => open(u)}>
            <img src={fileUrl(u.id)} loading="lazy" />
            <div className="album-meta">
              <span>{u.created_at.slice(5, 10)}</span>
              <span>{UPLOAD_KIND_LABEL[u.kind] ?? ''}</span>
            </div>
            {(u.note || u.doc_note) && <div className="album-note">{u.note || u.doc_note}</div>}
          </div>
        ))}
      </div>
      {!hasMore && !items.length && <Empty description="还没有上传过图片" />}
      <InfiniteScroll loadMore={loadMore} hasMore={hasMore}>
        {hasMore ? '加载中…' : items.length ? '没有更多了' : ''}
      </InfiniteScroll>
    </>
  );
}

export default function Docs() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'list';
  return (
    <div className="page tab-page">
      <NavBar back={null}>单据</NavBar>
      <Tabs activeKey={tab} onChange={(k) => setParams({ tab: k }, { replace: true })}>
        <Tabs.Tab title="记录" key="list" />
        <Tabs.Tab title="单据相册" key="album" />
      </Tabs>
      {tab === 'album' ? <Album /> : <DocList />}
    </div>
  );
}
