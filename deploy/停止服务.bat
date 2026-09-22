@echo off
rem geo-ui-browser 停止服务
chcp 65001 >nul
cd /d "%~dp0"
docker compose --env-file geo-ui-env down
echo 服务已停止
pause
