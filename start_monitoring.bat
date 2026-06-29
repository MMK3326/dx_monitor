@echo off
setlocal EnableDelayedExpansion

cd /d "%~dp0"

set "SERVER_EXE=%~dp0dist\dx-monitor-server\dx-monitor-server.exe"
set "SERVER_DIR=%~dp0dist\dx-monitor-server"
set "SOURCE_DASHBOARD=%~dp0dashboard"
set "DIST_DASHBOARD=%~dp0dist\dx-monitor-server\dashboard"
set "DIST_HISTORY=%~dp0dist\dx-monitor-server\history"
set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
set "PYTHONW_EXE=%LOCALAPPDATA%\Programs\Python\Python311\pythonw.exe"
set "CLOUDFLARED_EXE=%USERPROFILE%\tools\cloudflared.exe"
set "CLOUDFLARED_BAT=%USERPROFILE%\tools\run-dx-monitor-cloudflared-http2.bat"
set "CLOUDFLARED_LOG=%USERPROFILE%\tools\dx-monitor-cloudflared-live.log"
set "URL=http://127.0.0.1:5050"
set "API_URL=http://127.0.0.1:5050/api/dashboard"

if exist "%SOURCE_DASHBOARD%\index.html" (
  if exist "%DIST_DASHBOARD%" (
    robocopy "%SOURCE_DASHBOARD%" "%DIST_DASHBOARD%" /E /NFL /NDL /NJH /NJS /NC /NS >nul
  )
)

if not exist "%DIST_HISTORY%" mkdir "%DIST_HISTORY%"

call :check_server
if "%SERVER_READY%"=="1" (
  call :start_tunnel
  start "" "%URL%/?v=%date:~0,4%%date:~5,2%%date:~8,2%"
  goto :done
)

if exist "%PYTHONW_EXE%" (
  start "" /B /D "%~dp0" "%PYTHONW_EXE%" "%~dp0app.py"
) else if exist "%PYTHON_EXE%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath \"%PYTHON_EXE%\" -ArgumentList \"\"\"%~dp0app.py\"\"\" -WorkingDirectory \"%~dp0\" -WindowStyle Hidden"
) else if exist "%SERVER_EXE%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath \"%SERVER_EXE%\" -WorkingDirectory \"%SERVER_DIR%\" -WindowStyle Hidden"
) else (
  start "" /B py -3 "%~dp0app.py"
)

for /l %%i in (1,1,45) do (
  call :check_server
  if "!SERVER_READY!"=="1" goto :open_browser
  timeout /t 1 /nobreak >nul
)

:open_browser
if not "%SERVER_READY%"=="1" (
  echo DX Monitor server did not respond at %API_URL%.
  echo Check Python, dependencies, or port 5050 conflicts, then run this file again.
  pause
  goto :done
)
call :start_tunnel
start "" "%URL%/?v=%date:~0,4%%date:~5,2%%date:~8,2%"

:done
endlocal
exit /b

:check_server
set "SERVER_READY=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing '%API_URL%' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if "%ERRORLEVEL%"=="0" set "SERVER_READY=1"
exit /b

:start_tunnel
if not exist "%CLOUDFLARED_BAT%" exit /b
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (-not (Get-Process -Name cloudflared -ErrorAction SilentlyContinue)) { Start-Process -FilePath '%CLOUDFLARED_BAT%' }"
exit /b
