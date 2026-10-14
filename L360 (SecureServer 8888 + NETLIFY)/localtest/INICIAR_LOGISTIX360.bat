@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Logistix360 - Ambiente local de testes
echo ==============================================
echo   Logistix360 - Ambiente local de testes
echo ==============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado.
  echo Instale a versao LTS em https://nodejs.org/ e abra este arquivo novamente.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm nao encontrado. Reinstale o Node.js LTS.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Instalando dependencias. A primeira vez precisa de internet...
  call npm install
  if errorlevel 1 (
    echo Falha ao instalar dependencias.
    pause
    exit /b 1
  )
)
echo.
echo Iniciando o servidor de testes...
echo Quando aparecer a URL, abra http://localhost:8888 no navegador.
echo Para parar o site, feche esta janela ou pressione Ctrl+C.
echo.
call npm run dev
pause
