@echo off
setlocal EnableDelayedExpansion
title Bedrock WhatsApp Bot Launcher
color 0b

echo ==================================================
echo   INICIANDO INSTALADOR Y LANZADOR DEL BOT
echo ==================================================
echo.

:: 1. Verificar si Node.js está instalado o buscarlo en rutas comunes
set NODE_EXE=node
%NODE_EXE% -v >nul 2>&1
if %errorlevel% neq 0 (
    if exist "C:\Program Files\nodejs\node.exe" (
        set NODE_EXE="C:\Program Files\nodejs\node.exe"
        echo [^+] Node.js encontrado en la ruta por defecto: C:\Program Files\nodejs\node.exe
    ) else (
        echo [!] Node.js NO esta instalado en esta computadora o no esta en el PATH.
        echo [!] Procediendo a descargar el instalador oficial de Node.js...
        echo.
        
        :: Descargar el instalador de Node.js (LTS de 64 bits) usando PowerShell
        powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi' -OutFile 'node_installer.msi'"
        
        if not exist node_installer.msi (
            echo [!] Error al descargar el instalador de Node.js. Por favor, descargalo manualmente desde nodejs.org
            pause
            exit
        )

        echo.
        echo ==================================================
        echo   ATENCION: Se abrira el instalador de Node.js.
        echo   Por favor, completa la instalacion (Siguiente/Next)
        echo   y presiona una tecla cuando termine.
        echo ==================================================
        echo.
        
        :: Ejecutar el instalador de forma visible
        start /wait node_installer.msi
        
        :: Limpiar instalador
        del node_installer.msi
        
        node -v >nul 2>&1
        if %errorlevel% neq 0 (
            if exist "C:\Program Files\nodejs\node.exe" (
                set NODE_EXE="C:\Program Files\nodejs\node.exe"
            ) else (
                echo.
                echo [^+] Instalacion de Node.js finalizada.
                echo [^+] Por favor, CIERRA esta ventana de consola y vuelve a iniciar el bot.
                echo.
                pause
                exit
            )
        )
    )
)

echo [^+] Node.js detectado exitosamente.
echo.

:: 2. Instalar dependencias si no existe la carpeta node_modules
if not exist node_modules (
    echo [!] Carpeta de dependencias faltante. Instalando librerias de WhatsApp y Servidor...
    echo.
    call npm install --omit=dev
    echo.
    echo [^+] Dependencias instaladas con exito.
    echo.
)

:: 3. Abrir la interfaz web automáticamente en el navegador por defecto
echo [^+] Iniciando el servidor y abriendo la interfaz web de control...
echo.
goto lanzar_seguro

:: 4. Ejecutar la aplicación
rem Servidor iniciado desde :lanzar_seguro

:lanzar_seguro
echo [^+] Revisando si el bot ya esta corriendo...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3001/api/status' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel% equ 0 (
    echo [^+] El bot ya esta corriendo. Abriendo interfaz...
    start http://localhost:3001
    exit /b 0
)

echo [^+] Iniciando servidor del bot...
start "Bedrock WhatsApp Bot Server" %NODE_EXE% index.js

echo [^+] Esperando a que el servidor web este listo...
for /l %%i in (1,1,30) do (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3001/api/status' -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }"
    if !errorlevel! equ 0 goto abrir_interfaz
    timeout /t 1 >nul
)

echo [!] El servidor tardo mas de lo esperado. Revisa la ventana "Bedrock WhatsApp Bot Server".
pause
exit /b 1

:abrir_interfaz
echo [^+] Servidor listo. Abriendo interfaz web de control...
start http://localhost:3001
exit /b 0
