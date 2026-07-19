@echo off
rem Starts the UK Transit Live server (if not already running) and opens the app.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:8620/api/config | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo Starting UK Transit Live server...
  start "UK Transit Live server" /min cmd /c "cd /d "%~dp0uk_transit_live" && python -m uvicorn server:app --port 8620"
  timeout /t 5 /nobreak >nul
)
start http://localhost:8620
