@echo off
REM Abre o NutriReceitas em http://localhost:5500 (necessario para o microfone funcionar)
cd /d "%~dp0"
where python >nul 2>nul && (set PY=python) || (set PY=py)
start "" http://localhost:5500
%PY% -m http.server 5500
