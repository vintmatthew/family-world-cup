@echo off
REM Double-click to refresh the tracker and open it in your browser.
cd /d "%~dp0"
node refresh.mjs
if %errorlevel%==0 (
  start "" "%~dp0index.html"
) else (
  echo.
  echo Something went wrong. Make sure Node.js is installed ^(https://nodejs.org^).
  pause
)
