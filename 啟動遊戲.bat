@echo off
chcp 65001 >nul
title GTA Low-Poly 開放世界啟動器
echo ======================================================
echo    GTA Low-Poly 開放世界 (OSM 實境地圖生成)
echo ======================================================
echo 正在啟動遊戲伺服器，並開啟瀏覽器...
echo 遊戲網址: http://localhost:5173
echo ======================================================
start http://localhost:5173
npm run dev
pause
