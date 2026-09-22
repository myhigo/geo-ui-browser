#!/usr/bin/env bash
# geo-ui-browser 一键部署（仅镜像场景：目标服务器无需代码仓库）
#
# 用法（一台新电脑/新服务器）：
#   1. docker pull <IMAGE>                       # 拉镜像
#   2. 准备 geo-ui-env：从模板复制并填写
#        cp .env.example geo-ui-env
#        编辑 geo-ui-env（IMAGE / GEO_DATA_DIR / DB_* / GEO_BASE_PATH 等）
#   3. bash deploy.sh                            # 一键提取模板并启动
#
# 可选环境变量：IMAGE=<镜像名>、ENV_FILE=<env文件名>
# 幂等：已存在 docker-compose.yml 则跳过提取；重复执行只会 up（配置变化自动 recreate）。
set -euo pipefail

IMAGE="${IMAGE:-geo-ui-browser:latest}"
ENV_FILE="${ENV_FILE:-geo-ui-env}"

# 0) 确保镜像就绪（本机没有则拉取）
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[deploy] 拉取镜像 $IMAGE ..."
  docker pull "$IMAGE"
fi

# 1) 缺 compose 模板 → 从镜像提取（镜像内 /deploy/ 自带 docker-compose.yml / .env.example）
if [ ! -f docker-compose.yml ]; then
  echo "[deploy] 从镜像提取部署模板（docker-compose.yml / .env.example）..."
  cid="$(docker create "$IMAGE")"
  docker cp "$cid:/deploy/." .
  docker rm "$cid" >/dev/null
fi

# 2) 缺 env 文件 → 提示补齐（不自动生成，避免假配置）
if [ ! -f "$ENV_FILE" ]; then
  echo "[deploy] 缺少 $ENV_FILE，请先准备："
  echo "        cp .env.example $ENV_FILE"
  echo "        并编辑 $ENV_FILE 中的 IMAGE / GEO_DATA_DIR / DB_* / GEO_BASE_PATH 等"
  exit 1
fi

# 3) 启动
echo "[deploy] 启动：docker compose --env-file $ENV_FILE up -d"
docker compose --env-file "$ENV_FILE" up -d

echo "[deploy] 完成。查看状态：docker compose --env-file $ENV_FILE ps"
echo "[deploy] 管理台：见 geo-ui-env 中 GEO_BASE_PATH（默认 http://<host>:8787/admin）"
