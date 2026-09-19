# 基础镜像自带 Chromium 与系统依赖，省去手工安装
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

# 国内网络下 archive.ubuntu.com 经常拉不动，可用 --build-arg USE_CN_MIRROR=true 切到阿里云源
ARG USE_CN_MIRROR=false

# 必须在 apt 之前：tzdata 安装时会交互式询问时区，非交互构建（无 stdin）会永久挂住
ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    DISPLAY=:99 \
    NODE_ENV=production

RUN if [ "$USE_CN_MIRROR" = "true" ]; then \
      sed -i 's|http://archive.ubuntu.com/ubuntu|https://mirrors.aliyun.com/ubuntu|g; s|http://security.ubuntu.com/ubuntu|https://mirrors.aliyun.com/ubuntu|g' /etc/apt/sources.list; \
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

VOLUME ["/data/geo"]
EXPOSE 8787 6080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
