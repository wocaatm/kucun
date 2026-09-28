#!/usr/bin/env bash
# 把线上数据库 + 图片拉到本地 server/data（覆盖本地数据，旧数据先挪到 data.bak-时间戳）
# 改代码或数据前先跑：cd server && npm run pull:online
set -euo pipefail
HOST=${HOST:-root@47.99.52.253}
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
ssh "$HOST" 'set -e; cd /opt/kucun/data && rm -f /tmp/kucun-pull.db && sqlite3 kucun.db ".backup /tmp/kucun-pull.db" \
  && tar -czf /tmp/kucun-pull.tgz -C /tmp kucun-pull.db -C /opt/kucun/data uploads && rm /tmp/kucun-pull.db'
scp -q "$HOST:/tmp/kucun-pull.tgz" "$TMP/pull.tgz"
ssh "$HOST" 'rm -f /tmp/kucun-pull.tgz'
tar -xzf "$TMP/pull.tgz" -C "$TMP"
if [ -d data ]; then mv data "data.bak-$(date +%Y%m%d%H%M%S)"; fi
mkdir -p data/backups
mv "$TMP/kucun-pull.db" data/kucun.db
mv "$TMP/uploads" data/uploads
rm -rf "$TMP"
echo "已同步线上数据到 server/data：$(sqlite3 data/kucun.db "SELECT COUNT(*) FROM docs") 张单据"
