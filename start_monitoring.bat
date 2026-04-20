@echo off
setlocal

cd /d "%~dp0"

set "PYTHON_EXE=%~dp0..\qc-monitor\.venv3\Scripts\python.exe"

start "" "http://127.0.0.1:5050"

if exist "%PYTHON_EXE%" (
  "%PYTHON_EXE%" "%~dp0app.py"
) else (
  py -3 "%~dp0app.py"
)

endlocal
