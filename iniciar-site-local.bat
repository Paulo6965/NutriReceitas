@echo off
cd /d "%~dp0"
python -m pip install -r backend\requirements.txt
python iniciar-site-local.py
