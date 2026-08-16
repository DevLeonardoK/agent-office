@echo off
REM Abre o Escritorio dos Agentes (sobe o servidor se preciso).
node "%~dp0ensure-server.mjs"
start "" "http://127.0.0.1:4517"
