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

rem 3) 读取镜像名（默认 geo-ui-browser:latest）
set "IMG=geo-ui-browser:latest"
for /f "usebackq tokens=2 delims==" %%i in (`findstr /B "IMAGE=" geo-ui-env`) do set "IMG=%%i"
if "%IMG%"=="" set "IMG=geo-ui-browser:latest"

rem 4) 镜像就绪（没有则拉取）
docker image inspect %IMG% >nul 2>nul
if errorlevel 1 (
  echo [deploy] 第一次运行，拉取镜像 %IMG%（约 1-2GB，视网速需要几分钟）...
  docker pull %IMG%
)

rem 5) 启动
echo [deploy] 启动服务 ...
docker compose --env-file geo-ui-env up -d

echo.
echo == 完成 ==
echo   管理台：http://localhost:8787/geoui/admin
echo   健康检查：http://localhost:8787/healthz
echo   停止服务：双击「停止服务.bat」
pause
