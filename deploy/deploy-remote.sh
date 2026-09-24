#!/usr/bin/env bash
# =============================================================================
# 本地封装脚本（在你自己的电脑上运行，不是服务器上）
# 作用：把部署包 + 一键脚本上传到 Lighthouse，再触发部署。
# 前置：你的电脑已能 ssh 到 122.51.235.201（已配公钥或已知密码）。
#
# 用法：
#   bash deploy/deploy-remote.sh            # 默认用 ubuntu 用户
#   bash deploy/deploy-remote.sh root       # 指定登录用户
#
# 本脚本只在“你本地”调用 scp/ssh，不会执行任何服务器配置。
# 真正的安装/部署逻辑在服务器端的 setup-lighthouse.sh 里。
# =============================================================================
set -euo pipefail

SERVER="122.51.235.201"
USER="${1:-ubuntu}"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PKG="hidden-object-web-deploy-20260910-110733.tar.gz"

echo "==> [本地] 上传部署包到 $USER@$SERVER:/tmp/"
scp "$SCRIPT_DIR/$PKG" "$USER@$SERVER:/tmp/"

echo "==> [本地] 上传一键脚本到 $USER@$SERVER:/tmp/"
scp "$SCRIPT_DIR/deploy/setup-lighthouse.sh" "$USER@$SERVER:/tmp/"

echo "==> [本地] SSH 进服务器执行部署（需要你输入 sudo 密码）"
ssh -t "$USER@$SERVER" 'sudo bash /tmp/setup-lighthouse.sh'

echo "==> 完成。验证："
echo "    ssh $USER@$SERVER 'curl -s http://127.0.0.1:3001/health'"
echo "    浏览器打开 http://122.51.235.201/"
