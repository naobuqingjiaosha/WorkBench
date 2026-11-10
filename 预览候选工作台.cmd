@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 and npm 11 are required.
  pause
  exit /b 1
)
node.exe "%~dp0scripts\preview.mjs"
set "launcherExit=%errorlevel%"
if not "%launcherExit%"=="0" pause
exit /b %launcherExit%
