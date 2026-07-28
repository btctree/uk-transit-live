@echo off
rem Runs the Oracle A1 capacity hunter, appending everything to hunter.log.
rem Launched by hunter_guard.ps1 via Start-Process -WindowStyle Hidden, so the
rem console is created with SW_HIDE and never appears on the desktop.
rem The start/exit markers make a silent death visible in the log afterwards.
cd /d "%~dp0"
echo === hunter start %date% %time% >> "%~dp0hunter.log"
py "%~dp0oci_launch.py" >> "%~dp0hunter.log" 2>&1
echo === hunter exited rc=%errorlevel% %date% %time% >> "%~dp0hunter.log"
