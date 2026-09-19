# 基础镜像自带 Chromium 与系统依赖，省去手工安装
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

# 国内网络下 archive.ubuntu.com 经常拉不动，可用 --build-arg USE_CN_MIRROR=true 切到阿里云源
ARG USE_CN_MIRROR=false
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

ENV TZ=Asia/Shanghai \
    DISPLAY=:99 \
    NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/data/geo"]
EXPOSE 8787 6080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
