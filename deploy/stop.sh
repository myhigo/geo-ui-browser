#!/usr/bin/env bash
# geo-ui-browser 停止服务（Linux/macOS）
set -euo pipefail
cd "$(dirname "$0")" || exit 1
docker compose --env-file geo-ui-env down
echo "服务已停止"
