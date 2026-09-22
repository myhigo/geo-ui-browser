#!/usr/bin/env bash
# geo-ui-browser 一键部署
#
# 分工：镜像=程序，仓库=模板文件。当前目录需提前放好模板：
#   docker-compose.yml / .env.example / deploy.sh（scp 或首次 git clone 一次即可）
#
# 用法：
#   1. docker pull <IMAGE>                           # 拉镜像
#   2. cp .env.example geo-ui-env && vi geo-ui-env   # 改模板（IMAGE / GEO_DATA_DIR / DB_* / GEO_BASE_PATH）
#   3. bash deploy.sh                                # 启动（幂等，可重复执行；配置变化自动 recreate）
#
# 可选环境变量：IMAGE=<镜像名>、ENV_FILE=<env文件名>
# 注意：变量一律用 ${VAR} 花括号形式——macOS 自带 bash 3.2 在双引号内解析
#       $VAR 紧跟中文（UTF-8 多字节）时会把后续字节误并入变量名导致 unbound。
set -euo pipefail

IMAGE="${IMAGE:-geo-ui-browser:latest}"
ENV_FILE="${ENV_FILE:-geo-ui-env}"

# 0) 模板文件必须已在当前目录（提前放好，不从镜像取）
[ -f docker-compose.yml ] || { echo "[deploy] 缺少 docker-compose.yml，请先把模板文件放到当前目录"; exit 1; }

# 1) 确保镜像就绪（本机没有则拉取）
if ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "[deploy] 拉取镜像 ${IMAGE} ..."
  docker pull "${IMAGE}"
fi

# 2) 缺 env 文件 → 提示补齐（不自动生成，避免假配置）
if [ ! -f "${ENV_FILE}" ]; then
  echo "[deploy] 缺少 ${ENV_FILE}，请先准备："
  echo "        cp .env.example ${ENV_FILE}"
  echo "        并编辑 ${ENV_FILE} 中的 IMAGE / GEO_DATA_DIR / DB_* / GEO_BASE_PATH 等"
  exit 1
fi

# 3) 启动
echo "[deploy] 启动：docker compose --env-file ${ENV_FILE} up -d"
docker compose --env-file "${ENV_FILE}" up -d

echo "[deploy] 完成。查看状态：docker compose --env-file ${ENV_FILE} ps"
echo "[deploy] 管理台：见 geo-ui-env 中 GEO_BASE_PATH（默认 http://<host>:8787/admin）"
