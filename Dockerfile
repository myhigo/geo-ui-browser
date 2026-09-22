# 基础镜像自带 Chromium 与系统依赖，省去手工安装。
# ⚠️ 该 tag 必须与 package.json 里 playwright 的版本严格一致（当前锁定 1.62.1）：
#    不一致时 npm 装的 playwright 会去找另一个版本的 chromium
#    （例如 1.62.1 要 /ms-playwright/chromium-1234/chrome-linux64/chrome，
#     而 v1.47.0 镜像只带 chromium-1134），登录窗口直接起不来。
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

# 国内网络下 archive.ubuntu.com 直连经常 502（v1.62.x 镜像用的是 azure.archive.ubuntu.com），
# 可用 --build-arg USE_CN_MIRROR=true 切到阿里云源。
ARG USE_CN_MIRROR=false

# 必须在 apt 之前：tzdata 安装时会交互式询问时区，非交互构建（无 stdin）会永久挂住
ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    DISPLAY=:99 \
    NODE_ENV=production

# 用正则匹配任意子域（archive. / azure.archive. / security.），
# 否则 v1.62.x 镜像的 azure.archive.ubuntu.com 匹配不到、换源不生效，apt 会 502 失败
RUN if [ "$USE_CN_MIRROR" = "true" ]; then \
      sed -i -E 's|https?://[a-zA-Z0-9.-]*archive\.ubuntu\.com/ubuntu|https://mirrors.aliyun.com/ubuntu|g; s|https?://[a-zA-Z0-9.-]*security\.ubuntu\.com/ubuntu|https://mirrors.aliyun.com/ubuntu|g' /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null || true; \
    fi

# 中文字体（截图否则全是方块）+ 虚拟屏 + VNC（容器内人工登录用）+ 时区
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-noto-cjk \
      tzdata \
      xvfb \
      x11vnc \
      websockify \
      novnc \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# 注意：上面 ENV NODE_ENV=production 会让 npm ci 默认跳过 devDependencies，
# 而 typescript / @types 都在 dev 里 → 必须显式 --include=dev，否则下一步 tsc 不存在。
# （npx tsc 会因此去 npm 拉冒牌包 tsc@2.0.3，只打印一句提示就退出，代码根本不会编译）
RUN if [ "$USE_CN_MIRROR" = "true" ]; then npm config set registry https://registry.npmmirror.com; fi \
 && npm ci --include=dev

COPY tsconfig.json ./
COPY src/ ./src/
# 用 npm run build（走 node_modules/.bin 里的本地 tsc），不要用 npx tsc
RUN npm run build && npm prune --omit=dev

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# —— 部署模板：镜像即部署包 ——
# 目标服务器只需拉镜像：docker create <镜像> 后用 docker cp <容器>:/deploy/. . 提取
# deploy.sh + docker-compose.yml + .env.example，cp .env.example geo-ui-env 填配置后
# bash deploy.sh 一键启动，全程无需代码仓库。镜像保持无状态：配置仍由宿主机 env 注入。
COPY deploy.sh /deploy/deploy.sh
COPY docker-compose.yml /deploy/docker-compose.yml
COPY .env.example /deploy/.env.example
RUN chmod +x /deploy/deploy.sh

VOLUME ["/data/geo"]
EXPOSE 8787 6080

# /healthz 固定在根路径、不随 GEO_BASE_PATH 移动（server.ts 里挂在 app 而非前缀 router），改前缀无需改这里
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
