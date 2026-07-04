@echo off
REM models.txt -> models.config.js 재생성 (Windows). 실행정책에 막히지 않게 PowerShell 우회 호출.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-models.ps1" %*
exit /b %ERRORLEVEL%
