@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

if not exist "apps\desktop\node_modules\electron\dist\electron.exe" goto missing
if not exist "apps\desktop\out\main\index.js" goto missing
if not exist "target\debug\pi-desktop-host-core.exe" goto missing

start "" "apps\desktop\node_modules\electron\dist\electron.exe" "%~dp0apps\desktop" %*
exit /b 0

:missing
echo The Catspub client has not been built in this directory.
echo Run pnpm build:js and cargo build -p host-core first.
pause
exit /b 1
