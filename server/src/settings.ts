// 业务配置：改这里即可，不需要改代码逻辑

// username 是登录账号，name 是页面上显示的名字（改这里后重启即生效）
export const USERS = [
  { username: 'lq', name: '卢琼' },
  { username: 'lc', name: '卢程' },
  { username: 'yhh', name: '虞慧慧' },
  { username: 'xrf', name: '许荣飞' },
];

export const DEFAULT_PASSWORD = '123qweasd';

// 利润分成（按用户名），合计应为 1
export const PROFIT_SHARES: Record<string, number> = { lq: 0.5, yhh: 0.5 };

// 刷单：刷手的钱照常算淘宝销售额；私下发的红包记支出「刷单」，寄出的东西在淘宝订单里改实发
export const EXPENSE_CATEGORIES = ['快递运费', '包装耗材', '刷单', '交通', '平台手续费', '其他'];
export const INCOME_CATEGORIES = ['追加投资', '其他收入'];
// 第一个是销售单的默认渠道
export const SALE_CHANNELS = ['淘宝', '微信', '闲鱼', '小红书', '其他'];
export const OUTBOUND_CATEGORIES = ['自用', '送人', '损耗'];

export const LOW_STOCK_THRESHOLD = 2;
export const SESSION_DAYS = 30;
