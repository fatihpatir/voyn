@echo off
title VOYN PWA - Yerel Sunucu
echo ==============================================
echo   VOYN PWA Baslatiliyor...
echo ==============================================
powershell -ExecutionPolicy Bypass -File "%~dp0start-server.ps1"
pause
