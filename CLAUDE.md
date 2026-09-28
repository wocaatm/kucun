# 小库存 · 协作规则

## 改动前先同步线上数据（必须）

线上才是真实账本，本地 `server/data` 只是副本，会过期。任何代码或数据改动之前先跑：

```bash
cd server && npm run pull:online   # 拉线上 kucun.db + uploads 覆盖本地，旧的挪到 server/data.bak-时间戳
```

- 用 SSH（root@47.99.52.253，本机 `~/.ssh/id_ed25519` 已授权）；连不上时退而用网页备份接口：
  `POST /api/backups` 生成 → `GET /api/backups/:name` 下载，解压出 `kucun-snapshot.db`
- 本地试跑迁移、导入等改动，确认结果后再发版（`./deploy.sh`），再在线上执行
- 线上数据只能通过应用接口或导入改，不要直接改线上数据库

## 淘宝订单导入

- 数据来源：千牛导出的两张 Excel（主订单表 + 子订单表），每天导入；按订单号 / 子订单号幂等更新
- 命令行：`cd server && npm run import:taobao -- 主订单.xlsx 子订单.xlsx [--dry]`；页面：我的 → 淘宝订单导入
- 规则见 README「淘宝订单」一节
