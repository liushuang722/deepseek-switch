@echo off
cd /d %~dp0

echo ==============================================
echo        Starting DeepSeek Proxy UI...
echo ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js LTS first.
  echo https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, please wait...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

for /f "delims=" %%P in ('node -e "try{const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.json','utf8'));console.log(c.port||11435)}catch(e){console.log(11435)}"') do set UI_PORT=%%P

echo Opening http://127.0.0.1:%UI_PORT%/
start "" "http://127.0.0.1:%UI_PORT%/"

echo.
echo Keep this window open while using Codex CLI.
echo Press Ctrl+C to stop the proxy.
echo.
call npm start
if errorlevel 1 (
  echo.
  echo Startup failed. If the port is already in use, DeepSeek Switch may already be running.
  echo Open http://127.0.0.1:%UI_PORT%/ or change the port in config.json and try again.
  echo.
)

pause
