@echo off
chcp 65001 >nul
:: 品牌名同步 resources\frontend\brand-config.js（改名时同时改这里 + 重新打包 app.asar）
title Lavans - 43127 Launcher

echo ==========================================
echo  Lavans - Auto Start System
echo  Port: 43127
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
echo [2/5] Checking port 43127...

set PORT=43127
set PORT_RANGE_END=43127
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul
if %errorlevel% equ 0 (
    echo ERROR: Port 43127 is already in use. Lavans will not stop the other program.
    pause
    exit /b 1
)

echo Port 43127 available

echo.
echo [3/5] Installing dependencies (if needed)...
if exist package.json (
    call npm install
)

echo.
echo [4/5] Starting server...

start "Lavans Server" cmd /k "node server.js"

echo Waiting server boot...
timeout /t 3 >nul

echo.
echo [5/5] Opening browser...

start http://localhost:43127

echo.
echo DONE
echo Server running at http://localhost:43127
echo.
pause
