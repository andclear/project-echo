#!/bin/bash
set -e

# 1. 确定并确保用户数据与备份卷目录存在
USER_DATA_DIR="/root/.config/project-echo"
DB_DIR="$USER_DATA_DIR/database"
BACKUP_DIR="$USER_DATA_DIR/backups"
mkdir -p "$DB_DIR" "$BACKUP_DIR"

# 🚀 2. 物理碎石防线：彻底清除由于重启或断电残留的 Xvfb 锁文件，从根本上绝杀 failed to start 重启死循环！
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

echo "[Docker Entrypoint] 正在后台极速拉起虚拟 Xvfb 显卡服务..."
# 🚀 3. 后台异步拉起 Xvfb（绑定物理显示器通道 :99）
Xvfb :99 -screen 0 1024x768x24 -ac +extension GLX +render -noreset &
sleep 2  # 等待 2 秒让 Xvfb 稳定初始化就绪

export DISPLAY=:99
export DOCKER_MODE=true

echo "[Docker Entrypoint] 虚拟显卡服务已就绪。正在全力直拉起 Electron 主服务..."
# 🚀 4. 直拉起 Electron 主程序！丢弃 xvfb-run 外壳，让所有 console.log 及底层报错 100% 绝对透明显示在 logs 屏幕上！
exec ./node_modules/.bin/electron ./out/main/index.js --no-sandbox --disable-gpu --disable-software-rasterizer --headless
