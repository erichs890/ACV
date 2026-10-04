@echo off
setlocal
cd /d "%~dp0"
title ACV

rem Um clique sobe TUDO: o servidor (4780), que e com quem a extensao conversa, e a tela (5173).
rem
rem O servidor vai por `npm run servidor`, nao por `npm run core`: o core usa --watch e cai quando um arquivo
rem do projeto e salvo. Isso ja derrubou uma candidatura no meio, em 29/09.

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
echo   Subindo o servidor do ACV em uma segunda janela...
start "ACV - servidor" cmd /k "npm run servidor"

echo.
echo   ACV
echo   --------------------------------------------------------------
echo   Tela:      http://localhost:5173
echo   Servidor:  http://localhost:4780  (e com ele que a extensao fala)
echo.
echo   Com as duas janelas abertas, o icone da extensao fica AZUL.
echo   Nao ha nada para configurar: ela se conecta sozinha.
echo   --------------------------------------------------------------
echo.
echo   Feche as duas janelas para parar.
echo.

call npm run dev -- --open

pause
