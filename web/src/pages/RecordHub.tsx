import { useNavigate } from 'react-router-dom';
import { NavBar } from 'antd-mobile';

const GROUPS = [
  {
    title: '库存',
    items: [
      { icon: '📦', label: '进货入库', desc: '扫码 / 拍小票 AI 识别', to: '/new/purchase' },
      { icon: '🛍️', label: '销售出库', desc: '扫码 / 卖货截图识别', to: '/new/sale' },
      { icon: '🎁', label: '其他出库', desc: '自用 / 送人 / 损耗', to: '/new/outbound' },
      { icon: '📋', label: '盘点', desc: '按实际数量纠正库存', to: '/new/stocktake' },
    ],
  },
  {
    title: '钱',
    items: [
      { icon: '💸', label: '支出', desc: '运费、耗材、交通…', to: '/money/expense' },
      { icon: '💰', label: '收入', desc: '追加投资 / 其他收入', to: '/money/income' },
      { icon: '🔁', label: '转账 / 报销', desc: '账户之间结清', to: '/money/transfer' },
      { icon: '↩️', label: '退货退款', desc: '打开原销售单发起', to: '/docs' },
      { icon: '🛒', label: '淘宝订单', desc: '导入 Excel、应收、待办', to: '/taobao' },
    ],
  },
];

export default function RecordHub() {
  const nav = useNavigate();
  return (
    <div className="page tab-page">
      <NavBar back={null}>记一笔</NavBar>
      {GROUPS.map((g) => (
        <div key={g.title}>
          <div className="section-title">{g.title}</div>
          <div className="hub-grid">
            {g.items.map((it) => (
              <div key={it.label} className="hub-item" onClick={() => nav(it.to)}>
                <span className="hub-icon">{it.icon}</span>
                <b>{it.label}</b>
                <span className="muted small">{it.desc}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
