#!/bin/bash
set -e

# 1. 确定并确保用户数据与备份卷目录存在
USER_DATA_DIR="/root/.config/project-echo"
DB_DIR="$USER_DATA_DIR/database"
BACKUP_DIR="$USER_DATA_DIR/backups"
mkdir -p "$DB_DIR" "$BACKUP_DIR"

# 2. 自动注入局域网托管设定
if [ -f "$DB_DIR/echo" ]; then
  echo "[Docker Entrypoint] 检测到本地数据库，正在物理预写入局域网配置..."
else
  echo "[Docker Entrypoint] 正在初始化全新本地数据库并预写入局域网配置..."
fi

sqlite3 "$DB_DIR/echo" <<EOF
CREATE TABLE IF NOT EXISTS Settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO Settings (key, value) VALUES ('general_config', '{"lan_mapping_enabled":true,"lan_mapping_port":6868}');
EOF

echo "[Docker Entrypoint] 数据设定注入成功。正在使用 Xvfb 虚拟化设备管理器无头启动 Electron..."

# 3. 物理环境变量注入并启动应用
# --no-sandbox 确保 Electron 在容器 Root 权限下顺畅运行起飞
export DOCKER_MODE=true
exec xvfb-run --server-args="-screen 0 1024x768x24" \
  ./node_modules/.bin/electron ./out/main/index.js --no-sandbox --disable-gpu --disable-software-rasterizer --headless
