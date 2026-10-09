@echo off
title wb-trae-checkin installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
