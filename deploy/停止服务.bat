@echo off
rem geo-ui-browser 停止服务
chcp 65001 >nul
cd /d "%~dp0"
docker compose --env-file geo-ui-env down

rem 确认容器已完全退出再报完成
set /a n=0
:waitstop
set /a n+=1
set "RUN="
for /f "usebackq" %%i in (`docker compose --env-file geo-ui-env ps -q`) do set "RUN=1"
if not defined RUN goto stopped
if %n% geq 15 (
  echo [提示] 容器未完全退出，请检查：docker compose --env-file geo-ui-env ps
  pause
  exit /b 1
)
ping -n 2 127.0.0.1 >nul
goto waitstop
:stopped
echo 服务已停止
pause
