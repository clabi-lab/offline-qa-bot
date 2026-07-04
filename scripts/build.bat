@echo off
REM src\*.js -> app.js 결합 (Windows). 실행정책에 막히지 않게 PowerShell 우회 호출.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
exit /b %ERRORLEVEL%
