@echo off
setlocal

cd /d "%~dp0"
title Vectorizer.AI Desktop Dev

if exist "%USERPROFILE%\.cargo\bin" (
    set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
    echo Node.js/npm was not found on PATH.
    echo Install Node.js, then run this launcher again.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Installing npm dependencies...
    call npm.cmd install
    if errorlevel 1 (
        echo.
        echo npm install failed.
        pause
        exit /b 1
    )
)

echo Launching Vectorizer.AI Desktop from the current source tree...
echo.
call npm.cmd run desktop:dev
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo Vectorizer.AI Desktop dev process exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
