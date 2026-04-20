@echo off
cd /d "%~dp0"
echo DX Monitor Server starting...
echo.
echo Local:   http://127.0.0.1:5050
echo Network: check this PC's IP and open http://SERVER_IP:5050 from another PC
echo.
dx-monitor-server.exe
pause
