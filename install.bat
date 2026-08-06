@echo off
rem Устанавливает мост, который сохраняет переписки Kwork на диск.
rem Запуск: install.bat [папка для переписок]
chcp 65001 >nul
node "%~dp0scripts\install-bridge.mjs" %*
pause
