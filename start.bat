@echo off
setlocal
cd /d "%~dp0"
title ACV

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js nao encontrado. Instale em https://nodejs.org e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instalando dependencias ^(so na primeira vez^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo Falha ao instalar as dependencias.
    pause
    exit /b 1
  )
)

echo.
echo Iniciando o nucleo do ACV (automacao) em uma segunda janela...
start "ACV - nucleo" cmd /k "npm run core"

echo ACV rodando em http://localhost:5173
echo Feche as duas janelas para parar.
echo.
call npm run dev -- --open

pause
