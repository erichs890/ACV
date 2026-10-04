@echo off
setlocal
cd /d "%~dp0"
title ACV - servidor da extensao

rem Sobe SO o nucleo (porta 4780), que e com quem a extensao conversa.
rem
rem Diferente do start.bat, aqui nao sobe a tela em 5173: para usar a extensao no navegador voce nao precisa
rem do app aberto. E diferente do `npm run core`, este nao usa --watch: salvar um arquivo do projeto nao
rem derruba o servidor no meio de uma candidatura (ja aconteceu em 29/09).

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
echo   ACV - servidor da extensao
echo   --------------------------------------------------------------
echo   Enquanto esta janela estiver aberta, o icone da extensao fica
echo   AZUL. Feche a janela e ele fica CINZA.
echo   --------------------------------------------------------------

rem Espera o servidor responder e mostra o token (precisa ser colado uma vez no popup da extensao).
rem A rota e aberta de proposito e so atende 127.0.0.1: e assim que a extensao e pareada com o nucleo.
start "" /b node mostrar-token.mjs

call npm run servidor

echo.
echo   O servidor parou. O icone da extensao vai ficar cinza.
pause
