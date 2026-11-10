@echo off
rem Build and start the current checkout; preserve local data and configuration.
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or later is required. Please install it and try again.
  pause
  exit /b 1
)
node.exe "%~dp0scripts\start.mjs" --start-only --background --open
set "launcherExit=%errorlevel%"
if not "%launcherExit%"=="0" pause
exit /b %launcherExit%
