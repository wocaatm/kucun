#!/usr/bin/env bash
# 一键发版：本地打包前端 → 上传 → 服务器装依赖 → pm2 重启
# 需要能 ssh root@47.99.52.253（建议配 SSH 密钥）；数据目录 /opt/kucun/data 和 server/.env 不会被覆盖
set -euo pipefail
HOST=${HOST:-root@47.99.52.253}
cd "$(dirname "$0")"
(cd web && npm run build)
COPYFILE_DISABLE=1 tar --no-xattrs -czf /tmp/kucun.tgz \
  server/src server/scripts server/package.json server/package-lock.json server/tsconfig.json server/.env.example web/dist README.md
scp /tmp/kucun.tgz "$HOST:/tmp/kucun.tgz"
ssh "$HOST" 'set -e
  export PATH=/root/.nvm/versions/node/v25.2.1/bin:$PATH
  cd /opt/kucun && rm -rf web/dist server/src server/scripts && tar -xzf /tmp/kucun.tgz && rm /tmp/kucun.tgz
  cd server && npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com
  pm2 restart kucun --update-env && sleep 2 && curl -sf -o /dev/null http://127.0.0.1:3100/ && echo "发版成功"'
