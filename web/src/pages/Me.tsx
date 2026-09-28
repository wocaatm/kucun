import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, Form, Input, List, NavBar, Toast } from 'antd-mobile';
import { get, money, post, toFen, type Doc } from '../api';
import { useSession } from '../store';

export default function Me() {
  const nav = useNavigate();
  const { user, meta, logout, refreshMeta } = useSession();
  const [syncing, setSyncing] = useState(false);
  const syncAldi = async () => {
    setSyncing(true);
    try {
      const r = await post<{ fetched: number; created: number; updated: number }>('/api/sync/aldi');
      Toast.show({ content: `同步完成：${r.fetched} 个商品，新增 ${r.created}`, icon: 'success', duration: 2500 });
      refreshMeta();
    } catch (e: any) {
      Toast.show({ content: e.message, icon: 'fail' });
    } finally {
      setSyncing(false);
    }
  };
  return (
    <div className="page tab-page">
      <NavBar back={null}>我的</NavBar>
      <div className="card me-card">
        <div className="avatar">{user?.name.slice(0, 1).toUpperCase()}</div>
        <div>
          <div className="product-name">{user?.name}</div>
          <div className="muted small">
            我的账户：
            {(() => {
              const a = meta?.accounts.find((x) => x.user_id === user?.id);
              if (!a || a.balance === 0) return '已结清';
              return a.balance < 0 ? `垫付待还 ${money(-a.balance)}` : `代收待交 ${money(a.balance)}`;
            })()}
          </div>
        </div>
      </div>
      <List header="数据">
        <List.Item onClick={() => nav('/taobao?tab=import')} arrow description="每天导入千牛导出的两张订单表：生成销售、应收、退款">
          淘宝订单导入
        </List.Item>
        <List.Item onClick={() => nav('/plugin')} arrow description="装在电脑 Chrome 里，每天自动导出千牛订单，按需拉取商品 SKU">
          淘宝插件
        </List.Item>
        <List.Item onClick={() => nav('/opening')} arrow description="期初资金、期初垫付、期初库存">
          期初设置
        </List.Item>
        <List.Item onClick={() => nav('/products/import')} arrow description="下载模板，批量导入商品">
          Excel 导入商品
        </List.Item>
        <List.Item
          description={(() => {
            const c = meta?.catalogs.find((x) => x.source === 'aldi');
            return c ? `${c.count} 个商品，${c.synced_at.slice(5, 16)} 同步；只供查询和建档，不占库存` : '还没同步';
          })()}
          extra={
            <Button size="small" color="primary" fill="outline" loading={syncing} loadingText="同步中" onClick={syncAldi}>
              同步
            </Button>
          }
        >
          奥乐齐商品库
        </List.Item>
        <List.Item onClick={() => nav('/backup')} arrow description="每天自动备份，可下载到电脑">
          数据备份
        </List.Item>
        <List.Item onClick={() => nav('/logs')} arrow>
          操作日志
        </List.Item>
      </List>
      <List header="账号">
        <List.Item onClick={() => nav('/password')} arrow>
          修改密码
        </List.Item>
        <List.Item
          onClick={async () => {
            if (await Dialog.confirm({ content: '确定退出登录？' })) logout();
          }}
        >
          <span className="down">退出登录</span>
        </List.Item>
      </List>
    </div>
  );
}

export function PasswordPage() {
  const nav = useNavigate();
  return (
    <div className="page">
      <NavBar onBack={() => nav(-1)}>修改密码</NavBar>
      <Form
        mode="card"
        onFinish={async (v) => {
          if (v.new_password !== v.confirm) return void Toast.show('两次输入的新密码不一致');
          try {
            await post('/api/me/password', v);
            Toast.show({ content: '已修改', icon: 'success' });
            nav(-1);
          } catch (e: any) {
            Toast.show({ content: e.message, icon: 'fail' });
          }
        }}
        footer={
          <Button block type="submit" color="primary" size="large">
            保存
          </Button>
        }
      >
        <Form.Item name="old_password" label="原密码" rules={[{ required: true }]}>
          <Input type="password" />
        </Form.Item>
        <Form.Item name="new_password" label="新密码" rules={[{ required: true, min: 6, message: '至少 6 位' }]}>
          <Input type="password" />
        </Form.Item>
        <Form.Item name="confirm" label="确认新密码" rules={[{ required: true }]}>
          <Input type="password" />
        </Form.Item>
      </Form>
    </div>
  );
}

export function OpeningPage() {
  const nav = useNavigate();
  const { meta, refreshMeta } = useSession();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [values, setValues] = useState<Record<number, string>>({});

  const load = () => get<{ items: Doc[] }>('/api/docs?type=opening_balance,opening_stock&status=active&limit=100').then((r) => setDocs(r.items));
  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    const entries = Object.entries(values).filter(([, v]) => v && Number(v) !== 0);
    if (!entries.length) return void Toast.show('请至少填一项');
    const ok = await Dialog.confirm({ content: `确认记录 ${entries.length} 条期初余额？` });
    if (!ok) return;
    for (const [id, v] of entries) {
      const acc = meta!.accounts.find((a) => a.id === Number(id))!;
      // 个人账户填的是「垫付金额」，账户余额记为负数（生意欠他的钱）
      const fen = acc.kind === 'person' ? -toFen(v) : toFen(v);
      await post('/api/docs', { type: 'opening_balance', account_id: acc.id, amount: fen, note: acc.kind === 'person' ? '期初垫付' : '期初资金' });
    }
    setValues({});
    Toast.show({ content: '已记录', icon: 'success' });
    refreshMeta();
    load();
  };

  return (
    <div className="page">
      <NavBar onBack={() => nav(-1)}>期初设置</NavBar>
      <div className="section-title">期初余额</div>
      <div className="muted small" style={{ padding: '0 16px 8px' }}>
        公共资金填起始资金；个人填「到目前为止自己垫付、还没报销的钱」。多次填写会累加，填错了去单据里作废。
      </div>
      <List>
        {meta?.accounts.map((a) => (
          <List.Item key={a.id} extra={<span className="muted small">当前 {money(a.balance)}</span>}>
            <div className="opening-row">
              <span>{a.kind === 'public' ? '公共资金' : `${a.name} 垫付`}</span>
              <Input
                type="number"
                inputMode="decimal"
                placeholder="金额（元）"
                value={values[a.id] ?? ''}
                onChange={(v) => setValues((s) => ({ ...s, [a.id]: v }))}
              />
            </div>
          </List.Item>
        ))}
      </List>
      <div style={{ padding: 16 }}>
        <Button block color="primary" onClick={save}>
          记录期初余额
        </Button>
      </div>
      <div className="section-title">期初库存</div>
      <div style={{ padding: '0 16px 12px' }}>
        <Button block onClick={() => nav('/products/import')}>
          用 Excel 导入期初库存
        </Button>
      </div>
      <List header="已记录的期初单据">
        {docs.map((d) => (
          <List.Item key={d.id} onClick={() => nav(`/docs/${d.id}`)} description={`${d.doc_date} · ${d.created_by_name}`} extra={d.type === 'opening_balance' ? money(d.amount) : d.item_summary?.slice(0, 20)}>
            {d.type === 'opening_balance' ? `期初余额 · ${d.account_name}` : '期初库存'}
          </List.Item>
        ))}
      </List>
    </div>
  );
}

export function BackupPage() {
  const nav = useNavigate();
  const [items, setItems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const load = () => get<{ items: string[] }>('/api/backups').then((r) => setItems(r.items));
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="page">
      <NavBar onBack={() => nav(-1)}>数据备份</NavBar>
      <div className="muted small" style={{ padding: 16 }}>
        服务器每天自动备份一次（数据库 + 全部图片），保留最近 14 份。建议每周下载一份到自己电脑。
      </div>
      <div style={{ padding: '0 16px 12px' }}>
        <Button
          block
          color="primary"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await post('/api/backups');
              await load();
              Toast.show('已生成');
            } finally {
              setBusy(false);
            }
          }}
        >
          立即备份
        </Button>
      </div>
      <List header="备份文件">
        {items.map((f) => (
          <List.Item key={f} extra={<a href={`/api/backups/${f}`}>下载</a>}>
            {f}
          </List.Item>
        ))}
      </List>
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  login: '登录',
  create_doc: '新建单据',
  void_doc: '作废单据',
  edit_doc: '修改单据',
  create_product: '新建商品',
  update_product: '修改商品',
  import_products: '导入商品',
  recognize: 'AI 识别',
  backup: '手动备份',
  change_password: '修改密码',
};

export function LogsPage() {
  const nav = useNavigate();
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => {
    get('/api/logs').then((r) => setItems(r.items));
  }, []);
  return (
    <div className="page">
      <NavBar onBack={() => nav(-1)}>操作日志</NavBar>
      <List>
        {items.map((l) => (
          <List.Item
            key={l.id}
            description={`${l.created_at} ${l.detail && l.detail !== '""' ? `· ${l.detail.slice(0, 60)}` : ''}`}
            onClick={() => l.target.startsWith('doc:') && nav(`/docs/${l.target.slice(4)}`)}
          >
            {l.user_name} {ACTION_LABEL[l.action] ?? l.action}
          </List.Item>
        ))}
      </List>
    </div>
  );
}
