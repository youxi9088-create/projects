#!/usr/bin/env bash
# =============================================================================
# 寻物故事馆 — 仅修复/启用 Nginx 站点（不重新构建，不动 API 代码）
# 适用：122.51.235.201 Lighthouse (Ubuntu)，已跑过 setup-lighthouse.sh 但 80 端口异常
#
# 用法（在你本机能连服务器的终端执行）：
#   scp deploy/fix-nginx-site.sh ubuntu@122.51.235.201:/tmp/
#   ssh ubuntu@122.51.235.201 'sudo bash /tmp/fix-nginx-site.sh'
# =============================================================================
set -uo pipefail   # 注意：不用 -e，便于诊断阶段即使出错也继续打印

APP_DIR="/opt/hidden-object-web"
NGX_CONF="$APP_DIR/deploy/lighthouse/hidden-object-web.nginx.conf"

echo "============================================================"
echo "[诊断] 1) 80 端口当前被谁占用"
echo "============================================================"
sudo ss -ltnp 2>/dev/null | grep ':80 ' || echo "  -> 没有任何进程监听 80"

echo
echo "============================================================"
echo "[诊断] 2) nginx 进程状态 & 它实际监听的端口"
echo "============================================================"
sudo systemctl is-active nginx 2>/dev/null && echo "  nginx 服务 active" || echo "  nginx 服务 NOT active"
sudo ss -ltnp 2>/dev/null | grep -E 'nginx' || echo "  -> nginx 当前未监听任何端口"

echo
echo "============================================================"
echo "[诊断] 3) 静态首页文件是否存在且可读"
echo "============================================================"
if [ -f "$APP_DIR/apps/web/dist/index.html" ]; then
  ls -l "$APP_DIR/apps/web/dist/index.html"
else
  echo "  -> 缺失！$APP_DIR/apps/web/dist/index.html 不存在，需重新 pnpm build"
fi

echo
echo "============================================================"
echo "[诊断] 4) sites-enabled 与 nginx 实际加载的 server 块"
echo "============================================================"
ls -l /etc/nginx/sites-enabled/ 2>/dev/null
echo "--- nginx -T 关键行 ---"
sudo nginx -T 2>/dev/null | grep -nE 'include (sites-enabled|conf.d)|listen 80|server_name|root |proxy_pass' | head -n 40

echo
echo "============================================================"
echo "[修复] 5) 复制配置 / 建立启用链接 / 移除默认 80 配置"
echo "============================================================"
if [ ! -f "$NGX_CONF" ]; then
  echo "  !!! 找不到 $NGX_CONF，无法继续。请确认部署包已解压到 $APP_DIR"
  exit 1
fi
sudo cp "$NGX_CONF" /etc/nginx/sites-available/hidden-object-web
sudo ln -sf /etc/nginx/sites-available/hidden-object-web /etc/nginx/sites-enabled/hidden-object-web
sudo rm -f /etc/nginx/sites-enabled/default /etc/nginx/conf.d/default.conf
echo "  sites-enabled 现状："
ls -l /etc/nginx/sites-enabled/

echo
echo "============================================================"
echo "[修复] 6) 语法校验 + 启动/重载 nginx"
echo "============================================================"
if ! sudo nginx -t; then
  echo "  !!! nginx -t 语法错误，请查看上方输出，先修配置再继续"
  exit 1
fi

# 若 80 被非 nginx 进程占用，nginx 将无法 bind，需先让用户确认
if sudo ss -ltnp 2>/dev/null | grep ':80 ' | grep -qv nginx; then
  echo "  !!! 80 端口被非 nginx 进程占用（见[诊断]1）。"
  echo "      nginx 启动会失败。请先排查该进程（多为 API 误绑 80 或旧 nginx 残留），"
  echo "      必要时执行：sudo systemctl stop <占用80的服务>; sudo pkill -f 'nginx: master'"
  echo "      然后重新运行本脚本。"
  exit 1
fi

sudo systemctl enable nginx
if sudo systemctl restart nginx 2>/dev/null; then
  echo "  nginx restart 成功"
else
  echo "  nginx restart 失败，尝试 reload："
  sudo systemctl reload nginx || echo "  reload 也失败，请手动查 journalctl -u nginx -n 50"
fi

echo
echo "============================================================"
echo "[验证] 7) 本机 80 端口首页 & 3001 健康检查"
echo "============================================================"
echo -n "  首页 http://127.0.0.1:80/  -> "
curl -sS -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:80/ || echo "连接失败"

echo -n "  首页是否返回 HTML："
if curl -sS http://127.0.0.1:80/ | grep -qi '<!doctype html>\|<html'; then
  echo "是（index.html 正常）"
else
  echo "否（返回的不是 HTML，问题仍在）"
fi

echo -n "  API 健康检查 http://127.0.0.1:3001/health -> "
curl -sS -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3001/health || echo "连接失败"

echo
echo "============================================================"
echo "完成。若首页 HTTP 200 且返回 HTML，用浏览器打开 http://122.51.235.201/ 即可。"
echo "把本脚本的全部输出贴回给我，我据此确认是否彻底解决。"
echo "============================================================"
