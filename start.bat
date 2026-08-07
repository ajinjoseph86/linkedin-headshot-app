@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "NODE_EXE="
set "NPM_CMD="

rem --- 1) Look for a portable Node folder extracted right next to this script ---
rem    (e.g. "node-v24.19.0-win-x64" from the ZIP download - no install/admin needed)
for /d %%D in ("node-v*-win-x64") do (
  if exist "%%D\node.exe" (
    set "NODE_EXE=%%~fD\node.exe"
    set "NPM_CMD=%%~fD\npm.cmd"
  )
)

rem --- 2) Otherwise fall back to a system-wide Node install, if any ---
if not defined NODE_EXE (
  where node >nul 2>nul
  if not errorlevel 1 (
    set "NODE_EXE=node"
    set "NPM_CMD=npm"
  )
)

if not defined NODE_EXE (
  echo.
  echo Couldn't find Node.js.
  echo.
  echo Download the ZIP ^(no install/admin rights needed^) from:
  echo   https://nodejs.org/en/download  -^> choose Windows, x64, .zip
  echo.
  echo Then right-click the downloaded zip -^> Extract All -^> extract it
  echo directly into this same folder, so you end up with a folder here named
  echo something like "node-v24.19.0-win-x64". Then double-click start.bat again.
  echo.
  pause
  exit /b 1
)

echo Using Node from: %NODE_EXE%

if not exist ".env" (
  echo Creating .env with your fal.ai key...
  (
    echo FAL_KEY=8c3d7179-5121-4cc9-9033-a481a83f585e:bd9b9ea3f1be2ac3176db2064ad14002
    echo PORT=3000
    echo DAILY_BUDGET_USD=10.00
  ) > ".env"
)

if not exist "node_modules" (
  echo Installing dependencies the first time - this can take a minute...
  call "%NPM_CMD%" install
  if errorlevel 1 (
    echo.
    echo npm install failed. Copy the error above and send it back for a fix.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo Starting Age Transform... your browser will open automatically in a few seconds.
echo Keep this window open while you use the app - closing it stops the server.
echo.

start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
"%NODE_EXE%" server.js

pause
