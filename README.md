# Bedrock WhatsApp Bot

Bot que manda mensajes programados (texto, PDF, imagen o nota de voz) a los
chats de WhatsApp Business que tienen cierta etiqueta. Se controla desde una
página local en `http://localhost:3001`.

- Node.js + [whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js) (abre WhatsApp Web en un Chrome oculto)
- Dos cuentas definidas en `config.json`: `cuenta_1` (bandido) y `cuenta_2` (bedrock)
- Envío automático según `cronSchedule` en `config.json` (hoy: cada 2 días a las 12:45)

---

## Instalación rápida (sin IA, sin Git)

1. En esta página: botón verde **Code** → **Download ZIP**.
2. Descomprime el ZIP donde quieras (por ejemplo en Descargas).
3. Doble clic en **`IniciarBot.bat`**.
   - Si la PC no tiene Node.js, el `.bat` descarga el instalador y lo abre: dale
     Siguiente hasta terminar. Si al final te pide cerrar la ventana, ciérrala y
     vuelve a darle doble clic a `IniciarBot.bat`.
   - La primera vez tarda unos minutos instalando. Se abre sola la página
     `http://localhost:3001`.
4. **Antes de escanear el QR**, en la cuenta **bedrock**: "Documento PDF
   Adjunto" → **📄 Seleccionar PDF** → elegir el menú → **💾 Guardar
   Configuración**. ([Por qué va primero](#5-subir-el-pdf-del-menú-antes-del-qr))
5. Escanea el QR con el **celular que tiene el WhatsApp Business de Bedrock**:
   WhatsApp → Dispositivos vinculados → Vincular un dispositivo.
6. Listo cuando la cuenta dice **Listo**.

---

## Instalación en una computadora nueva (instrucciones para la IA)

> **Para el usuario:** abre Claude Code (u otra IA con terminal) en cualquier
> carpeta y pégale esto:
>
> *"Instala el bot de https://github.com/Fabercommands/whatsapp-bedrock-bot siguiendo su README. Avísame
> cuando necesites el PDF del menú y cuando tenga que escanear el QR."*
>
> Ten a la mano el PDF del menú de Bedrock: no viene en el repo.

Eres una IA instalando este bot en Windows. Sigue los pasos en orden. No te
saltes las verificaciones y no "mejores" nada por tu cuenta.

### 1. Requisitos

Verifica cada uno con su comando. Si falta, instálalo con `winget`:

| Requisito | Verificar | Instalar si falta |
|---|---|---|
| Node.js 20 o más nuevo (probado con 24.14) | `node -v` | `winget install OpenJS.NodeJS.LTS` |
| Git | `git --version` | `winget install Git.Git` |

Después de instalar con winget, abre una terminal nueva para que el PATH se
actualice.

Google Chrome es opcional. Si está instalado en `C:\Program Files\Google\Chrome`,
el bot lo usa. Si no, `npm ci` descarga su propio Chromium.

### 2. Descargar el repositorio

El repo es público. No hace falta cuenta de GitHub.

```bash
cd "%USERPROFILE%\Downloads"
git clone https://github.com/Fabercommands/whatsapp-bedrock-bot.git
cd whatsapp-bedrock-bot
```

### 3. Instalar dependencias

```bash
npm ci
```

Usa `npm ci`, no `npm install` ni `npm update`. `package-lock.json` fija la
versión exacta de whatsapp-web.js que ya está probada. npm va a reportar
vulnerabilidades: **no corras `npm audit fix`**, porque cambia versiones y
puede romper la conexión con WhatsApp.

Al final de la instalación **tiene que aparecer** una de estas dos líneas:

```
[parche] Arreglo de envio de archivos aplicado a whatsapp-web.js.
[parche] whatsapp-web.js ya tiene el arreglo de envio de archivos.
```

Si en su lugar sale un error `[parche] ...`, **detente y avísale al usuario**.
Sin ese arreglo el bot se conecta, pero falla al mandar el PDF con
`Data passed to getter must include an id property`. Más detalles en
[`scripts/parchar-whatsapp-web.js`](scripts/parchar-whatsapp-web.js).

Verifica:

```bash
node -e "require('whatsapp-web.js'); console.log('ok')"
```

### 4. Primer arranque

**Antes de arrancar, pregúntale al usuario si el bot sigue prendido en otra
computadora.** Si las dos computadoras corren el bot con las mismas cuentas,
el envío automático sale dos veces y los clientes reciben mensajes repetidos.
Solo debe haber un bot prendido a la vez.

Arranca el bot con doble clic en `IniciarBot.bat`, o desde la terminal:

```bash
npm start
```

Abre `http://localhost:3001`. Todavía **no** escanees el QR.

### 5. Subir el PDF del menú (ANTES del QR)

El PDF del menú no viene en el repo. Pídeselo al usuario.

**Este paso va antes del QR por una razón.** `config.json` dice que la cuenta
bedrock manda PDF. Si el archivo falta, el bot no avisa: manda solo el texto
("Te comparto el menú en PDF…") sin el PDF, y después omite a esos contactos
porque ya recibieron el texto, así que nunca reciben el menú. Sin la cuenta
conectada el bot no puede enviar nada, por eso el PDF se sube primero.

En la página, en la cuenta **bedrock**: sección "Documento PDF Adjunto" →
**📄 Seleccionar PDF** → elegir el menú → **💾 Guardar Configuración**.

Verifica que exista `documento_cuenta_2.pdf` en la carpeta del bot. Debe pesar
menos de 20 MB; si pesa más, el bot lo omite.

La cuenta bandido (`cuenta_1`) está desactivada. Si algún día se activa,
necesita su nota de voz en "Nota de Voz Adjunta" antes de conectarla, por la
misma razón.

### 6. Vincular WhatsApp

Cada cuenta activa muestra un código QR. **El usuario** lo escanea con el
**celular que tiene el WhatsApp Business de esa cuenta**, no con su WhatsApp
personal: WhatsApp → Dispositivos vinculados → Vincular un dispositivo. Una
cuenta por QR. Tú no puedes hacer este paso.

Está listo cuando cada cuenta activa dice **Listo** en la página. Las cuentas
apagadas en `config.json` dicen Desactivado y no muestran QR. Eso es normal.

### 7. Arranque diario

- `IniciarBot.bat`: arranca el bot y abre la página de control
- `IniciarBotOculto.vbs`: lo mismo pero sin ventana de consola (para dejarlo en el inicio de Windows)

---

## Qué NO está en el repo (a propósito)

| Qué | Por qué | Qué hacer en la compu nueva |
|---|---|---|
| `.wwebjs_auth/` | Es la sesión de WhatsApp: quien la tenga controla la cuenta | Volver a escanear el QR |
| `documento_*.pdf`, `media_voice_*`, `media_image_*`, `Bedrock.pdf` | Material del negocio; el repo es público | Subirlos desde la página (paso 5) |
| `numeros_*.txt`, `contactos_rescatados.txt`, `reporte_*` | Números de teléfono de clientes | Se generan solos al exportar desde la página |
| `node_modules/` | Se reinstala | `npm ci` |
| `.env` | El bot solo lee `PORT` de ahí (por defecto 3001) | Nada, no hace falta |

## Problemas comunes

| Síntoma | Causa | Solución |
|---|---|---|
| `Data passed to getter must include an id property` al enviar | Falta el arreglo de whatsapp-web.js | `node scripts/parchar-whatsapp-web.js` y reiniciar el bot |
| "El bot YA esta corriendo (puerto 3001 ocupado)" | Ya hay una copia prendida | Abrir `http://localhost:3001` |
| El QR no aparece o la cuenta no conecta | Sesión vieja o dañada | Botón **🔌 Desvincular Celular** de esa cuenta y volver a escanear |
