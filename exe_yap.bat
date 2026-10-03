@echo off
cd /d "%~dp0"
python -m PyInstaller --noconfirm --onefile --windowed --name KickIndirici --icon assets\app.ico --add-data "web;web" --collect-all curl_cffi --collect-all webview kick_indir.py
