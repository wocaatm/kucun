import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, List, NavBar, Tag, Toast } from 'antd-mobile';
import { get, post } from '../api';

interface Task {
  id: number;
  kind: 'sync_orders' | 'sync_skus';
  status: 'pending' | 'running' | 'done' | 'failed';
  message: string;
  created_by_name: string | null;
  created_at: string;
  finished_at: string | null;
}

interface Status {
  token: string | null;
  last_seen: string | null;
  /** 同步后还没确认的订单数 */
  reviews: number;
  tasks: Task[];
}

const KIND = { sync_orders: '同步订单', sync_skus: '拉取商品 SKU' };
const STATUS: Record<Task['status'], { text: string; color: string }> = {
  pending: { text: '等插件领取', color: 'default' },
  running: { text: '进行中', color: 'primary' },
  done: { text: '完成', color: 'success' },
  failed: { text: '失败', color: 'danger' },
};

/** 插件多久没来算离线：它每分钟来一次 */
const online = (lastSeen: string | null) => !!lastSeen && Date.now() - new Date(lastSeen).getTime() < 3 * 60 * 1000;

export default function PluginPage() {
  const nav = useNavigate();
  const [data, setData] = useState<Status | null>(null);

  const load = useCallback(async () => setData(await get<Status>('/api/plugin')), []);
  useEffect(() => {
    load().catch((e) => Toast.show(e.message));
    const t = setInterval(() => load().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [load]);

  const reset = async () => {
    if (data?.token && !(await Dialog.confirm({ content: '重新生成连接码？插件里要换成新的，旧的立即失效。' }))) return;
    await post('/api/plugin/token');
    load();
  };

  const run = async (kind: Task['kind']) => {
    if (kind === 'sync_orders' && data?.reviews) {
      Toast.show(`上次同步还有 ${data.reviews} 单没确认，先确认完`);
      return nav('/taobao/review');
    }
    try {
      await post('/api/plugin/tasks', { kind });
      Toast.show(online(data?.last_seen ?? null) ? '已发给插件，一分钟内开始' : '已排上，插件上线后执行');
      load();
    } catch (e: any) {
      Toast.show({ content: e.message, icon: 'fail' });
      if (/没确认/.test(e.message)) nav('/taobao/review');
    }
  };

  if (!data) return null;
  const isOnline = online(data.last_seen);
  return (
    <div className="page">
      <NavBar onBack={() => nav(-1)}>淘宝插件</NavBar>
      <div className="card">
        <div className="muted small">
          插件装在登录着千牛的电脑 Chrome 里，用那里的登录态每天导出订单报表并导入，也能按这里的指令拉取商品和 SKU（用来提前对照库存商品）。
        </div>
        <div style={{ marginTop: 8 }}>
          <Tag color={isOnline ? 'success' : 'default'} fill="outline">
            {isOnline ? '插件在线' : '插件离线'}
          </Tag>
          <span className="muted small"> 上次联系：{data.last_seen ? new Date(data.last_seen).toLocaleString('zh-CN', { hour12: false }) : '从没连过'}</span>
        </div>
      </div>

      <List header="连接码（填到插件里）">
        <List.Item
          description={data.token ? '点一下复制' : '还没生成'}
          onClick={() => data.token && navigator.clipboard?.writeText(data.token).then(() => Toast.show('已复制'))}
          extra={
            <Button size="small" fill="outline" onClick={(e) => (e.stopPropagation(), reset())}>
              {data.token ? '重新生成' : '生成'}
            </Button>
          }
        >
          <span style={{ wordBreak: 'break-all' }}>{data.token ?? '—'}</span>
        </List.Item>
      </List>

      {data.reviews > 0 && (
        <div className="unmatched-hint light" style={{ margin: '12px 16px 0' }} onClick={() => nav('/taobao/review')}>
          上次同步还有 {data.reviews} 单没确认，确认完才能再同步订单 ›
        </div>
      )}
      <div className="btn-row" style={{ padding: '12px 16px 0' }}>
        <Button color="primary" onClick={() => run('sync_orders')}>
          同步订单
        </Button>
        <Button color="primary" fill="outline" onClick={() => run('sync_skus')}>
          拉取商品 SKU
        </Button>
      </div>
      <div className="muted small" style={{ padding: '6px 16px 0' }}>
        同步订单要 7 分钟左右（千牛两次导出要隔 5 分钟）。拉完 SKU 后去「淘宝订单 → SKU 对照」确认自动匹配。
      </div>

      <List header="最近的任务">
        {data.tasks.map((t) => (
          <List.Item
            key={t.id}
            description={
              <>
                <div>
                  {t.created_at.slice(5, 16)} · {t.created_by_name ?? '插件定时'}
                </div>
                {t.message && <div className={t.status === 'failed' ? 'down' : ''}>{t.message}</div>}
              </>
            }
            extra={
              <Tag color={STATUS[t.status].color} fill="outline">
                {STATUS[t.status].text}
              </Tag>
            }
          >
            {KIND[t.kind]}
          </List.Item>
        ))}
        {!data.tasks.length && <List.Item>还没有任务</List.Item>}
      </List>
    </div>
  );
}
