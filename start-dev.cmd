@echo off
cd /d "%~dp0"
cd hall-pass-app
call "%ProgramFiles%\nodejs\npm.cmd" start
pause
