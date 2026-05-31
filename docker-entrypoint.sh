#!/bin/bash
set -e

# 1. 确定并确保用户数据与备份卷目录存在
USER_DATA_DIR="/root/.config/project-echo"
DB_DIR="$USER_DATA_DIR/database"
BACKUP_DIR="$USER_DATA_DIR/backups"
mkdir -p "$DB_DIR" "$BACKUP_DIR"

# 🚀 2. D-Bus 极速拉起防线：自动初始化并拉起 dbus 系统总线，彻底根除 Electron 物理总线连接错误噪音！
if [ ! -e /run/dbus/system_bus_socket ]; then
  mkdir -p /var/run/dbus /run/dbus
  dbus-uuidgen --ensure
  dbus-daemon --system --fork 2>/dev/null || true
fi

# 🚀 3. 物理碎石与权限加固防线：
# 彻底清除由于重启或断电残留的 Xvfb 锁文件，并确保 X11 Socket 目录完美存在与权限闭环
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

echo "[Docker Entrypoint] 正在后台极速拉起虚拟 Xvfb 显卡服务..."
# 🚀 4. 后台异步拉起 Xvfb（绑定物理显示器通道 :99）
Xvfb :99 -screen 0 1024x768x24 -ac +extension GLX +render -noreset &

# 🚀 5. 轮询等待 Xvfb 真正就绪（最多等 10 秒），带强状态硬校验断言
XVFB_READY=false
for i in $(seq 1 10); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then
    XVFB_READY=true
    break
  fi
  sleep 1
done

if [ "$XVFB_READY" = false ]; then
  echo "[Docker Entrypoint] 致命错误: 虚拟显卡服务 Xvfb 启动超时（10秒内未就绪）！请检查系统依赖或日志。"
  exit 1
fi

export DISPLAY=:99
export DOCKER_MODE=true

echo "[Docker Entrypoint] 虚拟显卡与 D-Bus 服务已完美就绪。正在全力直拉起 Electron 主服务..."
# 🚀 6. 直拉起 Electron 主程序！丢弃 xvfb-run 外壳，让所有 console.log 及底层报错 100% 绝对透明显示在 logs 屏幕上！
exec ./node_modules/.bin/electron ./out/main/index.js --no-sandbox --disable-gpu --disable-software-rasterizer
