#!/usr/bin/env bash
# =============================================================================
# 寻物故事馆 — 腾讯云 Lighthouse (122.51.235.201) 一键部署脚本
# 适用：Ubuntu 22.04 轻量应用服务器镜像
# 用法（在你本地/能连服务器的终端执行，非本机）：
#   scp hidden-object-web-deploy-20260910-110733.tar.gz ubuntu@122.51.235.201:/tmp/
#   ssh ubuntu@122.51.235.201 'bash -s' < deploy/setup-lighthouse.sh
# 或先上传脚本再 ssh 进去 sudo bash /tmp/setup-lighthouse.sh
# =============================================================================
set -euo pipefail

# ===================== 需按实际情况修改的变量 =====================
APP_DIR="/opt/hidden-object-web"
SERVICE_USER="www-data"
# 服务器公网 IP / 域名。有域名后改成 https://your-domain
WEB_ORIGIN="http://122.51.235.201"
# 上传到服务器的部署包路径
DEPLOY_TARBALL="/tmp/hidden-object-web-deploy-20260910-110733.tar.gz"
# —— AI 网关密钥（留空则 GENERATOR_MODE=mock，主线 5 关可玩，创作不可用）——
AI_GATEWAY_BASE_URL="https://ai-gateway.aiae.ndhy.com/v1"
AI_GATEWAY_MODEL="gpt-5.5-2026-04-24"
AI_GATEWAY_API_KEY=""          # 需要“新建冒险”时填入真实 key
AIHUB_AGENT_TOKEN=""          # 需要素材生产时填入
# =============================================================================

echo "==> [1/6] 安装系统依赖（Node 22 / pnpm / nginx）"
sudo apt-get update -y
sudo apt-get install -y curl ca-certificates gnupg nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable
sudo corepack prepare pnpm@10.28.2 --activate
node -v && pnpm -v

echo "==> [2/6] 解压部署包到 $APP_DIR"
sudo mkdir -p "$APP_DIR"
sudo chown "$USER":"$USER" "$APP_DIR"
tar xzf "$DEPLOY_TARBALL" -C "$APP_DIR" --strip-components=1

echo "==> [3/6] 安装依赖并构建（前端 dist + API dist）"
cd "$APP_DIR"
pnpm install --frozen-lockfile
pnpm build

echo "==> [4/6] 数据目录授权给 $SERVICE_USER"
sudo chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR/apps/api/data"

echo "==> [5/6] 写环境变量 /etc/hidden-object-web.env"
sudo tee /etc/hidden-object-web.env > /dev/null <<EOF
NODE_ENV=production
PORT=3001
WEB_ORIGIN=$WEB_ORIGIN
GENERATOR_MODE=mock
AI_GATEWAY_BASE_URL=$AI_GATEWAY_BASE_URL
AI_GATEWAY_MODEL=$AI_GATEWAY_MODEL
AI_GATEWAY_API_KEY=$AI_GATEWAY_API_KEY
AIHUB_AGENT_TOKEN=$AIHUB_AGENT_TOKEN
EOF
sudo chmod 600 /etc/hidden-object-web.env

echo "==> [6/6] 配置 systemd + nginx 并启动"
sudo cp "$APP_DIR/deploy/lighthouse/hidden-object-web.service" /etc/systemd/system/
sudo cp "$APP_DIR/deploy/lighthouse/hidden-object-web.nginx.conf" /etc/nginx/sites-available/hidden-object-web
sudo ln -sf /etc/nginx/sites-available/hidden-object-web /etc/nginx/sites-enabled/hidden-object-web
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now hidden-object-web
sudo systemctl reload nginx

echo "==> 部署完成。请在本地/服务器执行验证："
echo "    curl http://127.0.0.1:3001/health"
echo "    curl http://122.51.235.201/health"
echo "浏览器打开 http://122.51.235.201/ 应看到首页"
