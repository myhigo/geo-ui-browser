#!/usr/bin/env bash
# geo-ui-browser 停止服务（Linux/macOS）
set -euo pipefail
cd "$(dirname "$0")" || exit 1
docker compose --env-file geo-ui-env down

# 确认容器已完全退出再报完成
n=1
for i in $(seq 1 15); do
  n="$(docker compose --env-file geo-ui-env ps -q 2>/dev/null | wc -l | tr -d ' ')"
  [ "${n}" -eq 0 ] && break
  sleep 1
done
if [ "${n}" -eq 0 ]; then
  echo "服务已停止"
else
  echo "[提示] 容器未完全退出，请检查：docker compose --env-file geo-ui-env ps"
  exit 1
fi
