@echo off
title Polymarket BTC 1:1 Live Chart v4.2
cd /d "%~dp0"

echo =======================================================
echo   POLYMARKET BTC 1:1 LIVE CHART (v4.2)
echo   Local Dual-Mode Launcher
echo =======================================================
echo.

where python >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo [INFO] Запуск локального сервера Python...
    start "" http://localhost:8088
    python run_app.py
    goto end
)

where node >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo [INFO] Запуск локального сервера Node.js...
    start "" http://localhost:8088
    node server.js
    goto end
)

echo [INFO] Python или Node.js не найдены. Открываем автономный файл в браузере...
start "" "%~dp0index.html"

:end
pause
