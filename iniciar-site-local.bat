@echo off
REM Inicia o NutriReceitas com o servidor backend e abre o navegador
cd /d "%~dp0"
where python >nul 2>nul && (set PY=python) || (set PY=py)
start "" http://localhost:5500
%PY% iniciar-site-local.py
