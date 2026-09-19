#!/bin/sh
# 容器启动：虚拟屏 → VNC（供 /admin 内嵌人工登录）→ Node 服务
# 三者同容器共享 DISPLAY=:99，比拆多容器更简单可靠。
set -e

echo "[entrypoint] 启动 Xvfb :99 ..."
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp &
XVFB_PID=$!

sleep 2

echo "[entrypoint] 启动 x11vnc ..."
x11vnc -display :99 -forever -shared -nopw -rfbport 5900 &
VNC_PID=$!

echo "[entrypoint] 启动 noVNC (6080) ..."
websockify --web=/usr/share/novnc 6080 localhost:5900 &
NOVNC_PID=$!

# 任一子进程退出即整体退出，避免"屏还在、服务没了"的僵尸状态
term() {
  echo "[entrypoint] 收到停止信号，关闭浏览器与服务..."
  kill -TERM "$NODE_PID" 2>/dev/null || true
  wait "$NODE_PID" 2>/dev/null || true
  kill -TERM "$NOVNC_PID" "$VNC_PID" "$XVFB_PID" 2>/dev/null || true
  exit 0
}
trap term TERM INT

echo "[entrypoint] 启动 node 服务 (8787) ..."
node dist/cli.js --server &
NODE_PID=$!

wait "$NODE_PID"
echo "[entrypoint] node 已退出，关闭辅助进程"
kill -TERM "$NOVNC_PID" "$VNC_PID" "$XVFB_PID" 2>/dev/null || true
