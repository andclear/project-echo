# 采用含有构建工具的 Node 官方镜像，以便进行原生 C++ 模块（better-sqlite3）重新编译
FROM node:20-bullseye

# 安装 Xvfb、sqlite3 以及 Electron 运行所需的全部底层 Linux 系统依赖库
RUN apt-get update && apt-get install -y \
    xvfb \
    x11-utils \
    dbus \
    libnss3 \
    libasound2 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libgbm1 \
    libxkbcommon0 \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. 复制依赖描述文件并执行安装
COPY package*.json ./
RUN npm ci

# 🚀 2. 在 Linux 容器内为当前构建环境重新编译 C++ 原生模块 better-sqlite3
# 这将 100% 消除跨平台 CPU 架构或 libc 不匹配导致的运行时报错
RUN npx electron-builder install-app-deps

# 3. 复制项目所有源码
COPY . .

# 4. 执行 Vite Build 编译前端和 Preload/Main 主逻辑
RUN npm run build

# 物理挂载卷路径说明：用户数据与备份持久化目录
VOLUME ["/root/.config/project-echo"]

# 只暴露 6868 统一的网页与 API 融合服务端口
EXPOSE 6868

# 复制入口脚本并赋予可执行权限
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
