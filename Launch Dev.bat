@echo off
setlocal

cd /d "%~dp0"
title Vectorizer.AI Desktop

set "APP_EXE=%~dp0dist-portable\windows-x64\Vectorizer.AI Desktop\Vectorizer.AI Desktop.exe"

if not exist "%APP_EXE%" (
    echo The portable development build was not found:
    echo.
    echo   %APP_EXE%
    echo.
    echo Ask Codex to build the latest portable app, or run:
    echo.
    echo   npm.cmd run portable:windows
    echo.
    echo This launcher intentionally does not compile anything.
    pause
    exit /b 1
)

start "" "%APP_EXE%"
exit /b 0
