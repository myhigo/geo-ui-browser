#!/usr/bin/env bash
# geo-ui-browser 一键启动（部署包自带全部文件，无需任何复制/编辑命令）
#
# 用法（微信传文件场景）：
#   1. 把整个 deploy 文件夹通过微信发到目标电脑，解压到任意目录
#   2. 用记事本打开 geo-ui-env，填 DB_PASSWORD=（其他值已配好）
#   3. 在文件夹里打开终端，运行：bash deploy.sh
#      （macOS/Linux 桌面也可以直接双击本文件）
#
# 前置：已安装 Docker（含 compose v2）
# 注意：变量一律用 ${VAR} 花括号形式——macOS bash 3.2 下 $VAR 紧跟中文会被误解析。
set -euo pipefail
cd "$(dirname "$0")" || exit 1

ENV_FILE="geo-ui-env"

echo "== geo-ui-browser 一键部署 =="

# 1) 部署包文件完整？
[ -f "${ENV_FILE}" ] || { echo "[错误] 缺少 ${ENV_FILE}，请把整个 deploy 文件夹完整传过来"; exit 1; }
[ -f docker-compose.yml ] || { echo "[错误] 缺少 docker-compose.yml，请把整个 deploy 文件夹完整传过来"; exit 1; }

# 2) Docker 可用？
command -v docker >/dev/null 2>&1 || { echo "[错误] 未检测到 Docker：Windows 请安装 Docker Desktop 并保持运行"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "[错误] 当前 Docker 不支持 compose v2，请升级 Docker 到最新版"; exit 1; }

# 3) 数据库密码填了吗？
db_pw="$(grep -E '^DB_PASSWORD=' "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '\r' | sed 's/^[[:space:]]*#.*//')"
if [ -z "${db_pw}" ]; then
  echo "[提示] geo-ui-env 里 DB_PASSWORD 还没填：用记事本打开 geo-ui-env，"
  echo "       在 DB_PASSWORD= 后面写上数据库密码并保存，然后重新运行本脚本"
  exit 1
fi

# 4) 镜像就绪（没有则拉取）
image="$(grep -E '^IMAGE=' "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '\r')"
image="${image:-geo-ui-browser:latest}"
if ! docker image inspect "${image}" >/dev/null 2>&1; then
  echo "[deploy] 第一次运行，拉取镜像 ${image}（约 1-2GB，视网速需要几分钟）..."
  docker pull "${image}"
fi

# 5) 启动
echo "[deploy] 启动服务 ..."
docker compose --env-file "${ENV_FILE}" up -d

echo
echo "== 完成 =="
base_path="$(grep -E '^GEO_BASE_PATH=' "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '\r')"
echo "  管理台：http://localhost:8787${base_path:-}/admin"
echo "  健康检查：http://localhost:8787/healthz"
echo "  停止服务：bash stop.sh（Windows 双击「停止服务.bat」）"
