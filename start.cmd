@echo off
cd /d "%~dp0"
echo Starting Book Finder at http://localhost:3737 (close this window to stop)
node src\server.js --open
pause
