const $ = (id) => document.getElementById(id);
const DEFAULTS = { server: 'https://kucun.kidslearnenglish.xyz', token: '', dailyAt: '21:30', tbUser: '', tbPass: '' };
const STEPS = { start: '准备导出', gap: '已导出订单报表，等 5 分钟再导宝贝明细', wait: '等千牛生成报表' };

const send = (msg) => chrome.runtime.sendMessage(msg);

async function load() {
  const { config = {} } = await chrome.storage.local.get('config');
  const cfg = { ...DEFAULTS, ...config };
  for (const k of Object.keys(DEFAULTS)) $(k).value = cfg[k];
  refresh();
}

async function refresh() {
  const r = await send({ type: 'status' });
  const job = r.job;
  $('status').innerHTML = job
    ? `进行中：${job.kind === 'sync_skus' ? '拉取商品 SKU' : `同步订单 · ${STEPS[job.step] ?? job.step}`}${
        job.waitLogin ? '<br><b>等你在千牛页面完成登录验证（滑块 / 短信）</b>' : ''
      } <a href="#" id="cancel">取消</a>`
    : '空闲';
  $('cancel')?.addEventListener('click', async (e) => {
    e.preventDefault();
    await send({ type: 'cancel' });
    refresh();
  });
  $('logs').textContent = (r.logs ?? []).join('\n');
}

$('save').addEventListener('click', async () => {
  const config = {
    server: $('server').value.trim().replace(/\/$/, ''),
    token: $('token').value.trim(),
    dailyAt: $('dailyAt').value || '21:30',
    tbUser: $('tbUser').value.trim(),
    tbPass: $('tbPass').value,
  };
  await chrome.storage.local.set({ config });
  $('status').textContent = '已保存';
});

for (const [id, kind] of [['orders', 'sync_orders'], ['skus', 'sync_skus']]) {
  $(id).addEventListener('click', async () => {
    const r = await send({ type: 'run', kind });
    if (r.error) $('status').textContent = r.error;
    else refresh();
  });
}

load();
setInterval(refresh, 3000);
