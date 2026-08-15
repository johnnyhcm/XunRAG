@echo off
rem Open firewall port 5173 for LAN access (PolicyBot Vite frontend)
rem Usage: right-click this file -> Run as administrator
netsh advfirewall firewall add rule name="PolicyBot-Vite-5173" dir=in action=allow protocol=TCP localport=5173
echo.
if %errorlevel%==0 (
  echo [OK] Port 5173 opened. LAN devices can now access https://YOUR-IP:5173
) else (
  echo [FAILED] Please right-click and "Run as administrator".
)
echo.
pause
