# 腾讯云 Lighthouse 部署

此游戏需要部署两部分：Vite 前端静态文件，以及 Fastify API。Nginx 对外提供同一域名；`/api/*` 反向代理到本机 `127.0.0.1:3001`，所以浏览器不再依赖开发机地址。

## 服务器准备

以下命令以 Ubuntu Lighthouse、代码目录 `/opt/hidden-object-web` 为例。需要 Node.js 22、pnpm 10 和 Nginx。

```bash
sudo apt update
sudo apt install -y nginx
corepack enable
corepack prepare pnpm@10.28.2 --activate
sudo mkdir -p /opt/hidden-object-web
sudo chown "$USER":"$USER" /opt/hidden-object-web
```

上传或拉取项目代码后，在项目根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build
sudo chown -R www-data:www-data apps/api/data
```

## API 环境变量

创建 `/etc/hidden-object-web.env`。默认主线不需要密钥；只有“新建冒险”的模型生成或素材生产需要填写相应变量。

```ini
# AI_GATEWAY_API_KEY=...
# AI_GATEWAY_BASE_URL=https://...
# AI_GATEWAY_MODEL=...
# AIHUB_AGENT_TOKEN=...
# AIHUB_ASSET_SKILL_DIR=...
```

不要将真实密钥提交到仓库或写入前端 `.env`。

## 启动与 Nginx

```bash
sudo cp deploy/lighthouse/hidden-object-web.service /etc/systemd/system/
sudo cp deploy/lighthouse/hidden-object-web.nginx.conf /etc/nginx/sites-available/hidden-object-web
sudo ln -s /etc/nginx/sites-available/hidden-object-web /etc/nginx/sites-enabled/hidden-object-web
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now hidden-object-web
sudo systemctl reload nginx
```

验证：

```bash
curl http://127.0.0.1:3001/health
curl http://127.0.0.1/health
sudo systemctl status hidden-object-web --no-pager
```

在 Lighthouse 防火墙放行 TCP 80；如配置域名与 HTTPS，再放行 TCP 443，并使用 Certbot 签发证书。
