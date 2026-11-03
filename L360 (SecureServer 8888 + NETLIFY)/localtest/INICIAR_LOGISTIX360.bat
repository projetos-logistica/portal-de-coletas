@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Logistix360 - Ambiente local de testes (Supabase)
echo ==============================================
echo   Logistix360 - Ambiente local de testes
echo   Banco de Dados: Supabase
echo ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado.
  echo Instale a versao LTS em https://nodejs.org/ e abra este arquivo novamente.
  pause
  exit /b 1
)

powershell -NoProfile -Command "$p = Get-NetTCPConnection -LocalPort 8888 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { $proc = Get-Process -Id $p.OwningProcess -ErrorAction SilentlyContinue; if ($proc -and $proc.Name -eq 'node') { Write-Host 'Encerrando instancia anterior do servidor (PID' $p.OwningProcess')...'; Stop-Process -Id $p.OwningProcess -Force; Start-Sleep -Seconds 2 } elseif ($proc) { Write-Host 'A porta 8888 esta ocupada por outro programa:' $proc.Name '(PID' $p.OwningProcess')'; exit 1 } }"
if errorlevel 1 (
  pause
  exit /b 1
)

echo Iniciando o servidor local...
echo.
node server.mjs
pause
