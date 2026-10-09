@echo off
title wb-trae-checkin uninstaller
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
pause
