@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo 请安装 Node.js 24 或更高版本，再双击启动工作台。
  pause
  exit /b 1
)
node.exe "%~dp0scripts\start.mjs" --start-only --background --open
set "launcherExit=%errorlevel%"
if not "%launcherExit%"=="0" pause
exit /b %launcherExit%
