@echo off
rem geo-ui-browser 一键启动（Windows）
rem 用法：把整个 deploy 文件夹通过微信发过来解压后，双击本文件即可
chcp 65001 >nul
cd /d "%~dp0"

echo == geo-ui-browser 一键部署 ==

rem 1) Docker 可用？
where docker >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Docker，请先安装 Docker Desktop 并保持运行
  pause
  exit /b 1
)
docker compose version >nul 2>nul
if errorlevel 1 (
  echo [错误] 当前 Docker 不支持 compose v2，请升级 Docker Desktop 到最新版
  pause
  exit /b 1
)

rem 2) 数据库密码填了吗？
findstr /R /C:"^DB_PASSWORD=$" geo-ui-env >nul 2>nul
if not errorlevel 1 (
  echo [提示] 请先用记事本打开 geo-ui-env，在 DB_PASSWORD= 后面填上数据库密码并保存
  pause
  exit /b 1
)

rem 3) 已在运行则退出（幂等，防止重复执行）
set "RUN="
for /f "usebackq" %%i in (`docker compose --env-file geo-ui-env ps -q`) do set "RUN=1"
if defined RUN (
  echo [提示] 服务已在运行。如需重启/更新：先双击「停止服务.bat」，再运行本脚本。
  pause
  exit /b 0
)

rem 4) 读取镜像名（默认 geo-ui-browser:latest）
set "IMG=geo-ui-browser:latest"
for /f "usebackq tokens=2 delims==" %%i in (`findstr /B "IMAGE=" geo-ui-env`) do set "IMG=%%i"
if "%IMG%"=="" set "IMG=geo-ui-browser:latest"

rem 5) 镜像就绪（没有则拉取）
docker image inspect %IMG% >nul 2>nul
if errorlevel 1 (
  echo [deploy] 第一次运行，拉取镜像 %IMG%（约 1-2GB，视网速需要几分钟）...
  docker pull %IMG%
)

rem 6) 读取 base path
set "BASE_PATH="
for /f "usebackq tokens=2 delims==" %%i in (`findstr /B "GEO_BASE_PATH=" geo-ui-env`) do set "BASE_PATH=%%i"

rem 7) 启动
echo [deploy] 启动服务 ...
docker compose --env-file geo-ui-env up -d

rem 8) 等服务完全就绪（healthz 可访问）再显示完成
set /a n=0
:waithealth
set /a n+=1
curl -fsS http://127.0.0.1:18787/healthz >nul 2>nul
if not errorlevel 1 goto ready
if %n% geq 60 (
  echo [错误] 服务在 120 秒内未就绪，请查看：docker compose --env-file geo-ui-env logs
  pause
  exit /b 1
)
ping -n 3 127.0.0.1 >nul
goto waithealth
:ready

echo.
echo == 完成 ==
echo   本机访问：http://127.0.0.1:18787%BASE_PATH%/admin
echo   停止服务：双击「停止服务.bat」
pause
