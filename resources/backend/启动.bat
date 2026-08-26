@echo off
chcp 65001 >nul
:: 品牌名同步 resources\frontend\brand-config.js（改名时同时改这里 + 重新打包 app.asar）
title Lavans - 3001 Auto Launcher

echo ==========================================
echo  Lavans - Auto Start System
echo  Port: 3001
echo ==========================================

cd /d %~dp0

echo.
echo [1/5] Checking Node.js...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not installed
    pause
    exit /b
)

echo Node OK

echo.
echo [2/5] Cleaning port 3001...

for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001') do (
    echo Killing PID %%a
    taskkill /F /PID %%a >nul 2>&1
)

echo Port 3001 cleared

echo.
echo [3/5] Installing dependencies (if needed)...
if exist package.json (
    call npm install
)

echo.
echo [4/5] Starting server...

start "V7 Server" cmd /k "node server.js"

echo Waiting server boot...
timeout /t 3 >nul

echo.
echo [5/5] Opening browser...

start http://localhost:3001

echo.
echo DONE
echo Server running at http://localhost:3001
echo.
pause
