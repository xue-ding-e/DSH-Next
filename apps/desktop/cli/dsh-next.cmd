@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\DSH Next.exe" --expose-internals "%~dp0..\..\..\app.asar\lib\next-cli-entry.js" %*
exit /b %errorlevel%
