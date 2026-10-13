const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const express = require('express');
const multer = require('multer');
require('dotenv').config();

const upload = multer();

// Prevenir caídas del servidor por archivos bloqueados de Puppeteer al cerrar sesión
process.on('uncaughtException', (err) => {
  console.error(' [Error Capturado] Excepción no controlada:', err.message);
});

const app = express();
const PORT = process.env.PORT || 3001;
const chromeExecutablePath = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find(filePath => fs.existsSync(filePath));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Estado global y logs
const logLines = [];
let cancelRequested = false;
let isSending = false;
let isPaused = false;
let campaignSentCount = 0;
const READY_GRACE_MS = 30000;
const OPERATION_TIMEOUT_MS = 45000;
const SEND_TIMEOUT_MS = 90000;
const PAGE_SETTLE_MS = 5000;
const CLIENT_STABLE_ATTEMPTS = 6;
function addLog(text) {
  const line = `[${new Date().toLocaleTimeString()}] ${text}`;
  console.log(line);
  logLines.push(line);
  if (logLines.length > 100) logLines.shift(); // Limitar a 100 líneas
}

// Cargar y guardar configuración
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, description) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${description} (${Math.round(ms / 1000)}s)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function isBrowserLostError(err) {
  const message = (err && err.message) ? err.message : String(err || '');
  return [
    'Execution context was destroyed',
    'Target closed',
    'detached Frame',
    'Session closed',
    'Protocol error',
    'getChat',
    'sendChatstate',
    'Cannot read properties of undefined',
    'Runtime.callFunctionOn timed out'
  ].some(fragment => message.includes(fragment));
}

function normalizeLabelName(value) {
  return (value || '')
    .toString()
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function getLabelsWithFallback(client) {
  let labels = [];
  let source = 'client.getLabels';

  try {
    labels = await withTimeout(client.getLabels(), OPERATION_TIMEOUT_MS, 'Tiempo de espera agotado al obtener etiquetas');
  } catch (err) {
    source = `client.getLabels error: ${err.message}`;
  }

  if (Array.isArray(labels) && labels.length > 0) {
    return { labels, source };
  }

  try {
    const rawLabels = await withTimeout(client.pupPage.evaluate(() => {
      const collection = window.require?.('WAWebCollections')?.Label;
      if (!collection) return [];
      const models = typeof collection.getModelsArray === 'function'
        ? collection.getModelsArray()
        : Object.values(collection.models || collection._models || {});

      return models
        .filter(Boolean)
        .map(label => {
          if (window.WWebJS?.getLabelModel) return window.WWebJS.getLabelModel(label);
          const serialized = typeof label.serialize === 'function' ? label.serialize() : label;
          return {
            id: serialized.id || label.id,
            name: serialized.name || label.name,
            hexColor: serialized.hexColor || label.hexColor
          };
        })
        .filter(label => label && label.id && label.name);
    }), OPERATION_TIMEOUT_MS, 'Tiempo de espera agotado al leer etiquetas internas');

    if (Array.isArray(rawLabels) && rawLabels.length > 0) {
      labels = rawLabels.map(label => ({
        ...label,
        getChats: () => getChatsByLabelIdSafe(client, label.id)
      }));
      source = 'WAWebCollections.Label';
    }
  } catch (err) {
    source = `${source}; fallback error: ${err.message}`;
  }

  return { labels: Array.isArray(labels) ? labels : [], source };
}

// Resuelve los chats de una etiqueta de forma RESILIENTE: uno por uno,
// saltando los que el WhatsApp Web actual no pueda resolver (p.ej. contactos
// con el nuevo formato @lid). Antes la libreria usaba Promise.all y un solo
// chat problematico tumbaba TODA la tanda con "Error: r".
async function getChatsByLabelIdSafe(client, labelId) {
  let ids = [];
  try {
    ids = await client.pupPage.evaluate((labelId) => {
      const label = window.require('WAWebCollections').Label.get(labelId);
      if (!label || !label.labelItemCollection) return [];
      return label.labelItemCollection.getModelsArray()
        .filter(it => it.parentType === 'Chat')
        .map(it => String(it.parentId));
    }, labelId);
  } catch (e) {
    // Respaldo: si no se pueden leer los IDs internos, usar el metodo normal.
    try { return await client.getChatsByLabelId(labelId); } catch (_) { return []; }
  }

  const chats = [];
  let skipped = 0;
  for (const id of ids) {
    try {
      const chat = await client.getChatById(id);
      if (chat) chats.push(chat); else skipped++;
    } catch (e) {
      skipped++;
    }
  }
  if (skipped > 0) {
    addLog(`[Sistema] ${skipped} chat(s) de la etiqueta no se pudieron resolver y se omitieron.`);
  }
  return chats;
}

function findMatchingLabels(labels, targetLabelName) {
  const normalizedTarget = normalizeLabelName(targetLabelName);
  return labels.filter(label => normalizeLabelName(label.name) === normalizedTarget);
}

async function readWhatsAppPageState(client) {
  if (!client || !client.pupBrowser || !client.pupBrowser.isConnected() || !client.pupPage || client.pupPage.isClosed()) {
    throw new Error('Navegador de WhatsApp cerrado o no inicializado');
  }

  return client.pupPage.evaluate(() => ({
    url: window.location.href,
    readyState: document.readyState,
    hasWWebJS: Boolean(window.WWebJS),
    hasCollections: Boolean(window.require?.('WAWebCollections')),
    title: document.title
  }));
}

async function waitForClientStable(account, client, attempts = CLIENT_STABLE_ATTEMPTS, settleMs = PAGE_SETTLE_MS) {
  const accountName = account.name;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const state = await withTimeout(client.getState(), OPERATION_TIMEOUT_MS, 'Tiempo de espera agotado al verificar estado de WhatsApp');
      const before = await withTimeout(readWhatsAppPageState(client), OPERATION_TIMEOUT_MS, 'Tiempo de espera agotado al revisar WhatsApp Web');
      await sleep(settleMs);
      const after = await withTimeout(readWhatsAppPageState(client), OPERATION_TIMEOUT_MS, 'Tiempo de espera agotado al confirmar estabilidad de WhatsApp Web');

      const pageReady = ['interactive', 'complete'].includes(after.readyState);
      const samePage = before.url === after.url;
      const connected = state === 'CONNECTED';

      if (connected && pageReady && samePage && after.hasWWebJS) {
        return true;
      }

      addLog(`[${accountName}] WhatsApp aun esta cargando (${attempt}/${attempts}). Estado=${state}, pagina=${after.readyState}.`);
    } catch (err) {
      lastError = err;
      addLog(`[${accountName}] WhatsApp Web no esta estable todavia (${attempt}/${attempts}): ${err.message}`);
      if (isBrowserLostError(err) && statuses[account.id]) {
        statuses[account.id].status = 'SINCRONIZANDO';
        statuses[account.id].readyAt = null;
      }
    }

    await sleep(settleMs);
  }

  throw new Error(`WhatsApp Web no quedo estable para enviar${lastError ? `: ${lastError.message}` : ''}`);
}

const configPath = path.join(__dirname, 'config.json');
let config = {};

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.accounts) {
        config.accounts.forEach(acc => {
          if (acc.enabled === undefined) acc.enabled = true;
          if (acc.labelName === undefined) acc.labelName = "Posible Cliente";
          if (acc.messageText === undefined) acc.messageText = "";
          if (acc.hasImage === undefined) acc.hasImage = false;
          if (acc.hasPdf === undefined) acc.hasPdf = false;
          if (acc.hasVoiceNote === undefined) acc.hasVoiceNote = false;
          if (acc.messageLimit === undefined) acc.messageLimit = 0;
          if (acc.avoidIfLastMessageIsFromMe === undefined) acc.avoidIfLastMessageIsFromMe = false;
        });
      }
      addLog('Configuración cargada correctamente.');
    } else {
      throw new Error('Config file does not exist');
    }
  } catch (err) {
    addLog('Error al cargar config.json, usando valores por defecto.');
    config = {
      cronSchedule: "45 12 */2 * *",
      accounts: [
        {
          id: "cuenta_1",
          name: "bandido",
          enabled: true,
          labelName: "Posible Cliente",
          messageText: "",
          hasImage: false,
          hasPdf: false,
          hasVoiceNote: false,
          messageLimit: 0,
          avoidIfLastMessageIsFromMe: false
        },
        {
          id: "cuenta_2",
          name: "bedrock",
          enabled: false,
          labelName: "Posible Cliente",
          messageText: "",
          hasImage: false,
          hasPdf: false,
          hasVoiceNote: false,
          messageLimit: 0,
          avoidIfLastMessageIsFromMe: false
        }
      ]
    };
    saveConfig();
  }
}


function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

loadConfig();

// Permite mandar UNO de varios mensajes al azar a cada contacto, en vez del
// mismo texto identico a todos (que es la bandera #1 de spam para WhatsApp).
// En la caja "Contenido del Mensaje" separa cada version con una linea que
// contenga solo === (tres o mas signos de igual). Ejemplo:
//
//   Hola, te recordamos la promo de hoy 🌐 bedrockmx.app
//   ===
//   Buen dia! Aprovecha la promo flash de hoy. Mas info: bedrockmx.app
//   ===
//   Hey! Solo por hoy tenemos promo. Escribenos si te interesa.
//
// Si no hay separador, se usa el texto tal cual (un solo mensaje, como antes).
function getMessageVariants(account) {
  // Preferir la lista de mensajes (cajas separadas en la interfaz).
  if (Array.isArray(account.messageVariants)) {
    const v = account.messageVariants
      .map(s => (s || '').toString().trim())
      .filter(s => s.length > 0);
    if (v.length > 0) return v;
  }
  // Compatibilidad con el formato viejo: texto unico separado por una linea ===.
  const raw = account.messageText || '';
  const parts = raw
    .split(/^\s*={3,}\s*$/m)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  return parts.length > 0 ? parts : [''];
}

// Estructura de clientes de WhatsApp
const clients = {};
const statuses = {};
const initRetries = {};

function getNextAccountNumber() {
  let max = 0;
  for (const acc of config.accounts || []) {
    const match = String(acc.id || '').match(/^cuenta_(\d+)$/);
    if (match) max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return max + 1;
}

function createAccount(name) {
  const nextNumber = getNextAccountNumber();
  const cleanName = (name || `campana_${nextNumber}`)
    .trim()
    .replace(/[<>"']/g, '')
    .slice(0, 60);
  return {
    id: `cuenta_${nextNumber}`,
    name: cleanName || `campana_${nextNumber}`,
    enabled: true,
    labelName: "Posible Cliente",
    messageText: "",
    messageVariants: [""],
    hasImage: false,
    hasPdf: false,
    hasVoiceNote: false,
    hasVideo: false,
    messageLimit: 0,
    avoidIfLastMessageIsFromMe: false
  };
}

// Eliminar candados obsoletos de Chromium que quedan tras un cierre abrupto.
// Sin esto, Puppeteer cree que "el navegador ya esta corriendo" y falla al iniciar.
function cleanupStaleLocks(accountId) {
  const sessionDir = path.join(__dirname, '.wwebjs_auth', `session-${accountId}`);
  if (!fs.existsSync(sessionDir)) return;
  const lockNames = ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  for (const name of lockNames) {
    const lockPath = path.join(sessionDir, name);
    if (fs.existsSync(lockPath)) {
      try {
        fs.rmSync(lockPath, { force: true });
        addLog(`[Sistema] Candado obsoleto eliminado: ${accountId}/${name}`);
      } catch (err) {
        addLog(`[Sistema] No se pudo eliminar candado ${accountId}/${name}: ${err.message}`);
      }
    }
  }
}

// Inicializar un cliente de WhatsApp
function initializeClient(account) {
  addLog(`Iniciando cliente para la cuenta: "${account.name}" (${account.id})...`);

  // Limpiar candados de una sesion anterior que no cerro bien
  cleanupStaleLocks(account.id);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: account.id
    }),
    // NO fijamos una version de WhatsApp Web a la fuerza. Antes estaba clavada
    // en 2.2412.54, que WhatsApp ya rechazo (por eso dejo de conectar). Al no
    // fijarla, la libreria usa la version actual que sirve WhatsApp y se
    // mantiene al dia sola.
    puppeteer: {
      handleSIGINT: false,
      protocolTimeout: 180000,
      headless: false,
      ...(chromeExecutablePath ? { executablePath: chromeExecutablePath } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    }
  });

  statuses[account.id] = {
    name: account.name,
    status: 'INICIANDO',
    qr: null,
    readyAt: null
  };

  client.on('qr', async (qr) => {
    try {
      const dataUrl = await QRCode.toDataURL(qr);
      statuses[account.id].status = 'QR';
      statuses[account.id].qr = dataUrl;
      statuses[account.id].readyAt = null;
      addLog(`[${account.name}] 🔄 Código QR generado. Listo para escaneo.`);
    } catch (err) {
      addLog(`[${account.name}] ❌ Error al generar imagen QR: ${err.message}`);
    }
  });

  client.on('loading_screen', (percent, message) => {
    statuses[account.id].status = 'SINCRONIZANDO';
    statuses[account.id].readyAt = null;
    addLog(`[${account.name}] Cargando WhatsApp Web ${percent || 0}% ${message || ''}`.trim());
  });

  client.on('ready', () => {
    statuses[account.id].status = 'READY';
    statuses[account.id].qr = null;
    statuses[account.id].readyAt = Date.now();
    addLog(`[${account.name}] 🚀 ¡Conectado y listo para operar!`);
  });

  client.on('auth_failure', (msg) => {
    statuses[account.id].status = 'ERROR';
    statuses[account.id].readyAt = null;
    addLog(`[${account.name}] ❌ Error de autenticación: ${msg}`);
  });

  client.on('disconnected', (reason) => {
    statuses[account.id].status = 'DESCONECTADO';
    statuses[account.id].readyAt = null;
    addLog(`[${account.name}] 🔌 Cuenta desconectada de WhatsApp: ${reason}`);
  });

  client.initialize().catch(err => {
    statuses[account.id].status = 'ERROR';
    statuses[account.id].readyAt = null;
    addLog(`[${account.name}] ❌ Fallo al inicializar Puppeteer: ${err.message}`);
  });

  clients[account.id] = client;

  setTimeout(async () => {
    try {
      if (statuses[account.id]?.status === 'INICIANDO' && client.pupBrowser && client.pupBrowser.isConnected()) {
        const pages = await client.pupBrowser.pages();
        const page = client.pupPage && !client.pupPage.isClosed() ? client.pupPage : pages[0];
        const currentUrl = page ? page.url() : '';
        if (!currentUrl || currentUrl === 'about:blank') {
          addLog(`[${account.name}] WhatsApp quedo en blanco; reintentando carga de web.whatsapp.com...`);
          await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
      }
    } catch (err) {
      addLog(`[${account.name}] No se pudo reintentar carga de WhatsApp Web: ${err.message}`);
    }
  }, 20000);

  setTimeout(async () => {
    if (statuses[account.id]?.status !== 'INICIANDO') return;
    initRetries[account.id] = (initRetries[account.id] || 0) + 1;
    if (initRetries[account.id] > 2) {
      statuses[account.id].status = 'ERROR';
      addLog(`[${account.name}] No logro iniciar tras varios reintentos. Mantengo la sesion sin borrar; prueba desvincular solo si necesitas QR nuevo.`);
      return;
    }
    addLog(`[${account.name}] Sigue en INICIANDO; reinicio suave del navegador (intento ${initRetries[account.id]}).`);
    try {
      if (client.pupBrowser && client.pupBrowser.isConnected()) {
        await client.pupBrowser.close();
      }
    } catch (err) {
      addLog(`[${account.name}] No se pudo cerrar navegador anterior: ${err.message}`);
    }
    delete clients[account.id];
    cleanupStaleLocks(account.id);
    initializeClient(account);
  }, 90000);
}

// Desvincular y limpiar caché de una cuenta
async function unlinkAccount(accountId) {
  addLog(`[Sistema] Desvinculando cuenta: ${accountId}...`);
  const client = clients[accountId];
  if (client) {
    try {
      await client.destroy();
      addLog(`[Sistema] Cliente Puppeteer destruido para ${accountId}.`);
    } catch (err) {
      addLog(`[Sistema] Error al destruir cliente Puppeteer: ${err.message}`);
    }
    delete clients[accountId];
  }

  // Delete session directory
  const sessionDir = path.join(__dirname, '.wwebjs_auth', `session-${accountId}`);
  if (fs.existsSync(sessionDir)) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      addLog(`[Sistema] Carpeta de sesión eliminada para ${accountId}.`);
    } catch (err) {
      addLog(`[Sistema] Error al eliminar carpeta de sesión: ${err.message}`);
    }
  }

  // Clear status
  statuses[accountId] = {
    name: config.accounts.find(a => a.id === accountId)?.name || accountId,
    status: 'DESCONECTADO',
    qr: null,
    readyAt: null
  };

  // Re-initialize client cleanly
  const account = config.accounts.find(acc => acc.id === accountId);
  if (account) {
    initializeClient(account);
  }
}

// Nota: la inicializacion de las cuentas se hace abajo, SOLO si el servidor
// logra reservar el puerto (ver app.listen). Asi evitamos que una segunda
// instancia abierta por error pelee por la misma sesion de WhatsApp.

// Función de envío de mensajes para un cliente específico
async function sendFromClient(account, client) {
  const accountName = account.name;
  addLog(`[${accountName}] ⏱️ Iniciando proceso de envío...`);
  
  try {
    if (!client || !client.pupBrowser || !client.pupPage || client.pupPage.isClosed()) {
      addLog(`[${accountName}] ❌ Navegador cerrado o no inicializado. Deteniendo envío.`);
      return;
    }

    // Confirmar que WhatsApp Web YA terminó de sincronizar. Justo después de
    // escanear el QR, WhatsApp recarga la página solo; si enviamos en ese
    // instante revienta con "Execution context was destroyed" / getLabels de
    // undefined. Mejor avisar y salir limpio.
    const accountStatus = statuses[account.id];
    if (accountStatus && accountStatus.readyAt) {
      const readyAgeMs = Date.now() - accountStatus.readyAt;
      if (readyAgeMs < READY_GRACE_MS) {
        addLog(`[${accountName}] Espera ${Math.ceil((READY_GRACE_MS - readyAgeMs) / 1000)}s mas antes de enviar; WhatsApp acaba de conectar.`);
        return;
      }
    }

    try {
      await waitForClientStable(account, client);
    } catch (e) {
      addLog(`[${accountName}] WhatsApp todavia no esta estable para enviar. ${e.message}`);
      return;
    }

    try {
      const state = await withTimeout(client.getState(), OPERATION_TIMEOUT_MS, 'Tiempo de espera agotado al verificar estado de WhatsApp');
      if (state !== 'CONNECTED') {
        addLog(`[${accountName}] ⏳ WhatsApp aún está sincronizando (estado: ${state}). Espera ~20 segundos tras vincular e intenta de nuevo.`);
        return;
      }
    } catch (e) {
      addLog(`[${accountName}] ⏳ WhatsApp todavía no está listo para enviar (terminando de sincronizar). Espera ~20 segundos e intenta de nuevo.`);
      return;
    }

    const labelLookup = await getLabelsWithFallback(client);
    const labels = labelLookup.labels;
    const matchingLabels = findMatchingLabels(labels, account.labelName);
    const targetLabel = matchingLabels[0];

    if (!targetLabel) {
      addLog(`[${accountName}] ❌ No se encontró la etiqueta "${account.labelName}" en esta cuenta.`);
      return;
    }

    addLog(`[${accountName}] ✅ Etiqueta encontrada: "${targetLabel.name}"`);
    
    let chats = [];
    const getChatsPromise = (async () => {
      try {
        return await targetLabel.getChats();
      } catch (e) {
        return await getChatsByLabelIdSafe(client, targetLabel.id);
      }
    })();

    chats = await withTimeout(getChatsPromise, OPERATION_TIMEOUT_MS, 'Tiempo de espera agotado al obtener chats de la etiqueta');

    if (!chats || chats.length === 0) {
      addLog(`[${accountName}] ℹ️ No se encontraron chats con la etiqueta "${account.labelName}".`);
      return;
    }

    // Verificar tamaños de archivos antes de iniciar envíos masivos para prevenir caídas de Chrome
    const maxFileSize = 20 * 1024 * 1024; // 20 MB
    let imageOk = true;
    let pdfOk = true;
    let voiceOk = true;

    if (account.hasImage) {
      const imagePath = path.join(__dirname, `media_image_${account.id}.jpg`);
      if (fs.existsSync(imagePath)) {
        const stats = fs.statSync(imagePath);
        if (stats.size > maxFileSize) {
          addLog(`[${accountName}] ⚠️ Advertencia: La imagen es muy grande (${(stats.size/1024/1024).toFixed(1)} MB). Límite de seguridad: 20 MB. Se enviará sin imagen.`);
          imageOk = false;
        }
      } else {
        imageOk = false;
      }
    }

    if (account.hasPdf) {
      const pdfPath = path.join(__dirname, `documento_${account.id}.pdf`);
      if (fs.existsSync(pdfPath)) {
        const stats = fs.statSync(pdfPath);
        if (stats.size > maxFileSize) {
          addLog(`[${accountName}] ⚠️ Advertencia: El PDF es muy grande (${(stats.size/1024/1024).toFixed(1)} MB). Límite de seguridad: 20 MB. Se omitirá el PDF.`);
          pdfOk = false;
        }
      } else {
        pdfOk = false;
      }
    }

    if (account.hasVoiceNote) {
      const voicePath = path.join(__dirname, `media_voice_${account.id}.ogg`);
      if (fs.existsSync(voicePath)) {
        const stats = fs.statSync(voicePath);
        if (stats.size > maxFileSize) {
          addLog(`[${accountName}] ⚠️ Advertencia: La nota de voz es muy grande (${(stats.size/1024/1024).toFixed(1)} MB). Límite de seguridad: 20 MB. Se omitirá la nota de voz.`);
          voiceOk = false;
        }
      } else {
        voiceOk = false;
      }
    }

    addLog(`[${accountName}] 🚀 Se detectaron ${chats.length} chats etiquetados. Iniciando envíos...`);
    let accountSentCount = 0;
    let hardError = false;

    for (let i = 0; i < chats.length; i++) {
      // Verificar si se alcanzó el límite establecido para la tanda actual
      if (account.messageLimit > 0 && accountSentCount >= account.messageLimit) {
        addLog(`[Sistema] ⏸️ Límite de envíos alcanzado (${account.messageLimit} mensajes) para ${accountName}. Pausando envío automáticamente...`);
        isPaused = true;
        accountSentCount = 0; // Reiniciar contador para la siguiente tanda al reanudar
      }

      while (isPaused && !cancelRequested) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (cancelRequested) {
        addLog(`[${accountName}] 🛑 Envío detenido por el usuario.`);
        break;
      }
      try {
        await waitForClientStable(account, client, 2, 1200);
      } catch (err) {
        hardError = true;
        statuses[account.id].status = 'SINCRONIZANDO';
        addLog(`[${accountName}] WhatsApp Web recargo o dejo de estar estable antes del siguiente contacto. Deteniendo tanda: ${err.message}`);
        break;
      }

      const chat = chats[i];
      const chatName = chat.name || chat.id.user;

      // Elegir al azar UNA de las variantes del mensaje para este contacto.
      const messageVariants = getMessageVariants(account);
      const chosenMessage = messageVariants[Math.floor(Math.random() * messageVariants.length)];

      // Evitar duplicados: si ya le enviamos CUALQUIERA de las variantes, lo omitimos
      try {
        const messages = await withTimeout(chat.fetchMessages({ limit: 5 }), OPERATION_TIMEOUT_MS, `Tiempo de espera agotado al verificar historial de "${chatName}"`);
        const alreadySent = messages.some(msg => msg.fromMe && messageVariants.some(v => msg.body.trim() === v.trim()));
        if (alreadySent) {
          addLog(`[${accountName}] ℹ️ Omitiendo "${chatName}": ya recibió este mensaje.`);
          continue;
        }

        // Evitar si el último mensaje del chat fue enviado por nosotros
        if (account.avoidIfLastMessageIsFromMe && messages.length > 0) {
          const lastMessage = messages[messages.length - 1];
          if (lastMessage.fromMe) {
            addLog(`[${accountName}] ℹ️ Omitiendo "${chatName}": el último mensaje del chat fue enviado por nosotros.`);
            continue;
          }
        }
      } catch (err) {
        addLog(`[${accountName}] ⚠️ Error al verificar historial de "${chatName}": ${err.message}`);
        if (isBrowserLostError(err)) {
          hardError = true;
          statuses[account.id].status = 'ERROR';
          addLog(`[${accountName}] 🛑 Conexión con el navegador perdida o sesión cerrada. Deteniendo campaña.`);
          break;
        }
      }


      
      try {
        const sendVoice = account.hasVoiceNote && voiceOk;
        const sendImage = account.hasImage && imageOk;
        const sendPdf = account.hasPdf && pdfOk;
        const sleepStep = 250;

        if (sendVoice) {
          await withTimeout(chat.sendStateRecording(), OPERATION_TIMEOUT_MS, `Tiempo de espera agotado al mostrar grabando a "${chatName}"`);
          // Simular tiempo de grabación entre 3 y 5 segundos
          const recordingDuration = Math.floor(Math.random() * 2000) + 3000;
          let elapsedRec = 0;
          while (elapsedRec < recordingDuration) {
            if (cancelRequested) break;
            while (isPaused && !cancelRequested) {
              await new Promise(resolve => setTimeout(resolve, 500));
            }
            if (cancelRequested) break;
            await sleep(sleepStep);
            elapsedRec += sleepStep;
          }
          if (cancelRequested) break;

          await withTimeout(chat.clearState(), OPERATION_TIMEOUT_MS, `Tiempo de espera agotado al limpiar estado de "${chatName}"`);

          // Enviar nota de voz sin subtítulo
          const voiceMedia = MessageMedia.fromFilePath(path.join(__dirname, `media_voice_${account.id}.ogg`));
          await withTimeout(client.sendMessage(chat.id._serialized, voiceMedia, { sendAudioAsVoice: true }), SEND_TIMEOUT_MS, `Tiempo de espera agotado al enviar nota de voz a "${chatName}"`);
          addLog(`[${accountName}]   🎙️ Nota de voz aceptada por WhatsApp Web para "${chatName}".`);

          // Esperar 2 segundos antes de mandar el texto o las imágenes para simular flujo humano
          let waitElapsed = 0;
          while (waitElapsed < 2000) {
            if (cancelRequested) break;
            await sleep(sleepStep);
            waitElapsed += sleepStep;
          }
          if (cancelRequested) break;
        }

        if (sendImage || sendPdf) {
          if (sendImage && sendPdf) {
            // Enviar imagen con pie de página primero
            const imageMedia = MessageMedia.fromFilePath(path.join(__dirname, `media_image_${account.id}.jpg`));
            await withTimeout(client.sendMessage(chat.id._serialized, imageMedia, { caption: chosenMessage }), SEND_TIMEOUT_MS, `Tiempo de espera agotado al enviar imagen a "${chatName}"`);
            
            // Pausa corta de 1.5 a 2.5 segundos para simular ritmo humano
            const innerWait = Math.floor(Math.random() * 1000) + 1500;
            let innerElapsed = 0;
            while (innerElapsed < innerWait) {
              if (cancelRequested) break;
              await sleep(sleepStep);
              innerElapsed += sleepStep;
            }
            
            if (!cancelRequested) {
              // Enviar PDF como documento
              const pdfMedia = MessageMedia.fromFilePath(path.join(__dirname, `documento_${account.id}.pdf`));
              await withTimeout(client.sendMessage(chat.id._serialized, pdfMedia, { caption: chosenMessage }), SEND_TIMEOUT_MS, `Tiempo de espera agotado al enviar PDF a "${chatName}"`);
            }
          } else if (sendImage) {
            const media = MessageMedia.fromFilePath(path.join(__dirname, `media_image_${account.id}.jpg`));
            await withTimeout(client.sendMessage(chat.id._serialized, media, { caption: chosenMessage }), SEND_TIMEOUT_MS, `Tiempo de espera agotado al enviar imagen a "${chatName}"`);
          } else if (sendPdf) {
            const media = MessageMedia.fromFilePath(path.join(__dirname, `documento_${account.id}.pdf`));
            await withTimeout(client.sendMessage(chat.id._serialized, media, { caption: chosenMessage }), SEND_TIMEOUT_MS, `Tiempo de espera agotado al enviar PDF a "${chatName}"`);
          }
          addLog(`[${accountName}]   ✅ Imagen/PDF aceptado por WhatsApp Web para "${chatName}".`);
        } else {
          // Si no enviamos archivos, enviamos el texto solo (pero solo si no está vacío)
          if (chosenMessage && chosenMessage.trim()) {
            // Si ya enviamos nota de voz, no volvemos a simular escritura para no cansar al receptor,
            // pero si no enviamos nota de voz, sí simulamos la escritura.
            if (!sendVoice) {
              await withTimeout(chat.sendStateTyping(), OPERATION_TIMEOUT_MS, `Tiempo de espera agotado al mostrar escribiendo a "${chatName}"`);
              const typingDuration = Math.floor(Math.random() * 3000) + 4000; // 4 a 7 segs
              let elapsedType = 0;
              while (elapsedType < typingDuration) {
                if (cancelRequested) break;
                while (isPaused && !cancelRequested) {
                  await new Promise(resolve => setTimeout(resolve, 500));
                }
                if (cancelRequested) break;
                await sleep(sleepStep);
                elapsedType += sleepStep;
              }
              await withTimeout(chat.clearState(), OPERATION_TIMEOUT_MS, `Tiempo de espera agotado al limpiar estado de "${chatName}"`);
            }
            if (!cancelRequested) {
              await withTimeout(client.sendMessage(chat.id._serialized, chosenMessage), SEND_TIMEOUT_MS, `Tiempo de espera agotado al enviar texto a "${chatName}"`);
              addLog(`[${accountName}]   ✅ Mensaje de texto aceptado por WhatsApp Web para "${chatName}".`);
            }
          }
        }

        accountSentCount++;
        campaignSentCount++; // Mantener para el estado global si se requiere

        if (i < chats.length - 1) {
          const waitDuration = Math.floor(Math.random() * 4000) + 3000;
          let waitElapsed = 0;
          while (waitElapsed < waitDuration) {
            if (cancelRequested) break;
            while (isPaused && !cancelRequested) {
              await new Promise(resolve => setTimeout(resolve, 500));
            }
            if (cancelRequested) break;
            await sleep(sleepStep);
            waitElapsed += sleepStep;
          }
        }
      } catch (err) {
        addLog(`[${accountName}]   ❌ Error al enviar a "${chatName}": ${err.message}`);
        if (isBrowserLostError(err)) {
          hardError = true;
          statuses[account.id].status = 'ERROR';
          addLog(`[${accountName}] 🛑 Conexión con el navegador perdida o sesión cerrada. Deteniendo campaña.`);
          break;
        }
      }
    }
    
    if (hardError) {
      addLog(`[${accountName}] Error critico de WhatsApp Web. El proceso se detuvo; reinicia la cuenta antes de reintentar.`);
    } else if (cancelRequested) {
      addLog(`[${accountName}] 🛑 Proceso de envío interrumpido.`);
    } else {
      addLog(`[${accountName}] 🎉 Proceso de envíos completado.`);
    }
  } catch (error) {
    if (isBrowserLostError(error)) {
      statuses[account.id].status = 'ERROR';
      if (statuses[account.id]) statuses[account.id].readyAt = null;
    }
    addLog(`[${accountName}] ❌ Error en el proceso: ${error.message}`);
  }
}

// Función global para enviar desde todas las cuentas activas
async function sendFromAllClients() {
  if (isSending) {
    addLog('⚠️ Ya hay un proceso de envío activo.');
    return;
  }
  isSending = true;
  cancelRequested = false;
  isPaused = false;
  campaignSentCount = 0; // Reiniciar contador al iniciar una nueva campaña

  addLog('==================================================');
  addLog('📢 INICIANDO ENVÍO AUTOMÁTICO DESDE TODAS LAS CUENTAS');
  addLog('==================================================');
  const readyAccounts = [];

  for (const acc of config.accounts) {
    if (cancelRequested) break;
    if (acc.enabled === false) {
      addLog(`[${acc.name}] 🚫 Omitido: Envíos desactivados por interruptor (toggle OFF).`);
      continue;
    }
    const client = clients[acc.id];
    if (statuses[acc.id] && statuses[acc.id].status === 'READY') {
      readyAccounts.push({ acc, client });
    } else {
      addLog(`[${acc.name}] ⚠️ Omitido: La cuenta no está conectada.`);
    }
  }
  if (readyAccounts.length === 0) {
    addLog('[Sistema] No hay cuentas activas y conectadas para enviar.');
  } else {
    addLog(`[Sistema] Enviando en paralelo desde ${readyAccounts.length} cuenta(s) activa(s).`);
    await Promise.all(readyAccounts.map(({ acc, client }) => sendFromClient(acc, client)));
  }

  isSending = false;
  cancelRequested = false;
}

// Programar tarea automatizada
cron.schedule(config.cronSchedule, () => {
  addLog('⏰ Alarma cron activada. Ejecutando envíos programados...');
  sendFromAllClients();
});

// --- Rutas de la API ---

// Obtener estados actuales de las cuentas
app.get('/api/status', (req, res) => {
  const list = config.accounts.map(acc => ({
    id: acc.id,
    name: acc.name,
    status: statuses[acc.id] ? statuses[acc.id].status : 'DESCONECTADO',
    qr: statuses[acc.id] ? statuses[acc.id].qr : null,
    enabled: acc.enabled !== false
  }));
  res.json({ accounts: list, isSending: isSending, isPaused: isPaused });
});

// Obtener la configuración actual (soporta accountId)
app.get('/api/config', (req, res) => {
  const accountId = req.query.accountId;
  const acc = config.accounts.find(a => a.id === accountId);
  if (acc) {
    res.json({
      cronSchedule: config.cronSchedule,
      accountId: acc.id,
      labelName: acc.labelName,
      messageText: acc.messageText,
      messageVariants: getMessageVariants(acc),
      hasImage: acc.hasImage || false,
      hasPdf: acc.hasPdf || false,
      hasVoiceNote: acc.hasVoiceNote || false,
      messageLimit: acc.messageLimit !== undefined ? acc.messageLimit : 0,
      avoidIfLastMessageIsFromMe: acc.avoidIfLastMessageIsFromMe || false
    });
  } else {
    const firstAcc = config.accounts[0];
    res.json({
      cronSchedule: config.cronSchedule,
      accountId: firstAcc ? firstAcc.id : '',
      labelName: firstAcc ? firstAcc.labelName : 'Posible Cliente',
      messageText: firstAcc ? firstAcc.messageText : '',
      messageVariants: firstAcc ? getMessageVariants(firstAcc) : [''],
      hasImage: firstAcc ? firstAcc.hasImage : false,
      hasPdf: firstAcc ? firstAcc.hasPdf : false,
      hasVoiceNote: firstAcc ? firstAcc.hasVoiceNote : false,
      messageLimit: firstAcc ? firstAcc.messageLimit : 0,
      avoidIfLastMessageIsFromMe: firstAcc ? firstAcc.avoidIfLastMessageIsFromMe : false
    });
  }
});

// Obtener la imagen guardada para una cuenta
app.get('/api/image', (req, res) => {
  const accountId = req.query.accountId;
  const imagePath = path.join(__dirname, `media_image_${accountId}.jpg`);
  if (fs.existsSync(imagePath)) {
    res.sendFile(imagePath, { dotfiles: 'allow' });
  } else {
    res.status(404).send('No hay imagen');
  }
});

// Obtener el documento PDF guardado para una cuenta
app.get('/api/pdf', (req, res) => {
  const accountId = req.query.accountId;
  const pdfPath = path.join(__dirname, `documento_${accountId}.pdf`);
  if (fs.existsSync(pdfPath)) {
    res.sendFile(pdfPath, { dotfiles: 'allow' });
  } else {
    res.status(404).send('No hay PDF');
  }
});

// Obtener la nota de voz guardada para una cuenta
app.get('/api/voice', (req, res) => {
  const accountId = req.query.accountId;
  const voicePath = path.join(__dirname, `media_voice_${accountId}.ogg`);
  if (fs.existsSync(voicePath)) {
    res.sendFile(voicePath, { dotfiles: 'allow' });
  } else {
    res.status(404).send('No hay nota de voz');
  }
});

// Actualizar la configuración de una cuenta
app.post('/api/config', upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'pdf', maxCount: 1 },
  { name: 'voiceNote', maxCount: 1 }
]), (req, res) => {
  const { accountId, labelName, messageText, imageChanged, pdfChanged, voiceNoteChanged, messageLimit, cronSchedule, avoidIfLastMessageIsFromMe } = req.body;
  
  if (cronSchedule) {
    config.cronSchedule = cronSchedule;
  }

  const acc = config.accounts.find(a => a.id === accountId);
  if (!acc) {
    return res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
  }

  if (labelName) acc.labelName = labelName;
  if (messageText !== undefined) acc.messageText = messageText;

  // Lista de mensajes (cajas separadas). Llega como JSON desde la interfaz.
  // A cada contacto se le manda UNO al azar (ver getMessageVariants).
  if (req.body.messageVariants !== undefined) {
    try {
      const arr = JSON.parse(req.body.messageVariants);
      if (Array.isArray(arr)) {
        const clean = arr.map(s => (s || '').toString());
        acc.messageVariants = clean;
        // Guardamos tambien el 1er mensaje en messageText por compatibilidad.
        acc.messageText = clean.find(s => s.trim().length > 0) || '';
      }
    } catch (e) {
      addLog(`[Sistema] No se pudieron leer los mensajes enviados: ${e.message}`);
    }
  }

  if (messageLimit !== undefined) acc.messageLimit = parseInt(messageLimit, 10) || 0;
  if (avoidIfLastMessageIsFromMe !== undefined) {
    acc.avoidIfLastMessageIsFromMe = (avoidIfLastMessageIsFromMe === 'true' || avoidIfLastMessageIsFromMe === true);
  }

  if (imageChanged === 'true') {
    const imagePath = path.join(__dirname, `media_image_${acc.id}.jpg`);
    if (req.files && req.files['image'] && req.files['image'][0]) {
      const fileBuffer = req.files['image'][0].buffer;
      fs.writeFileSync(imagePath, fileBuffer);
      acc.hasImage = true;
      addLog(`Nueva imagen adjunta guardada para ${acc.name}.`);
    } else {
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
      acc.hasImage = false;
      addLog(`Imagen eliminada de la configuración para ${acc.name}.`);
    }
  }

  if (pdfChanged === 'true') {
    const pdfPath = path.join(__dirname, `documento_${acc.id}.pdf`);
    if (req.files && req.files['pdf'] && req.files['pdf'][0]) {
      const fileBuffer = req.files['pdf'][0].buffer;
      fs.writeFileSync(pdfPath, fileBuffer);
      acc.hasPdf = true;
      addLog(`Nuevo documento PDF adjunto guardado para ${acc.name}.`);
    } else {
      if (fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath);
      }
      acc.hasPdf = false;
      addLog(`Documento PDF eliminado de la configuración para ${acc.name}.`);
    }
  }

  if (voiceNoteChanged === 'true') {
    const voicePath = path.join(__dirname, `media_voice_${acc.id}.ogg`);
    if (req.files && req.files['voiceNote'] && req.files['voiceNote'][0]) {
      const fileBuffer = req.files['voiceNote'][0].buffer;
      fs.writeFileSync(voicePath, fileBuffer);
      acc.hasVoiceNote = true;
      addLog(`Nueva nota de voz adjunta guardada para ${acc.name}.`);
    } else {
      if (fs.existsSync(voicePath)) {
        fs.unlinkSync(voicePath);
      }
      acc.hasVoiceNote = false;
      addLog(`Nota de voz eliminada de la configuración para ${acc.name}.`);
    }
  }
  
  saveConfig();
  addLog(`Configuración de cuenta "${acc.name}" actualizada desde la interfaz web.`);
  res.json({ success: true });
});

// Activar/Desactivar cuenta para envíos
// Agregar una nueva cuenta/campana con sesion propia
app.post('/api/accounts/add', (req, res) => {
  const requestedName = (req.body && req.body.name ? String(req.body.name) : '').trim();
  const account = createAccount(requestedName);

  config.accounts.push(account);
  saveConfig();

  addLog(`[Sistema] Nueva campana creada: "${account.name}" (${account.id}).`);
  initializeClient(account);

  res.json({ success: true, account });
});

app.post('/api/accounts/toggle', (req, res) => {
  const { id, enabled } = req.body;
  const account = config.accounts.find(acc => acc.id === id);
  if (account) {
    account.enabled = (enabled === true || enabled === 'true');
    saveConfig();

    if (account.enabled && !clients[account.id]) {
      addLog(`[${account.name}] Activada; iniciando cliente de WhatsApp para esta campana.`);
      initializeClient(account);
    } else if (!account.enabled && !clients[account.id]) {
      statuses[account.id] = {
        name: account.name,
        status: 'DESACTIVADO',
        qr: null,
        readyAt: null
      };
    }
    addLog(`[${account.name}] Envío de mensajes: ${account.enabled ? 'ACTIVADO' : 'DESACTIVADO'}`);
    res.json({ success: true, enabled: account.enabled });
  } else {
    res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
  }
});

// Renombrar una cuenta
app.post('/api/accounts/rename', (req, res) => {
  const { id, name } = req.body;
  const account = config.accounts.find(acc => acc.id === id);
  if (account && name && name.trim()) {
    const oldName = account.name;
    account.name = name.trim();
    if (statuses[id]) statuses[id].name = account.name;
    saveConfig();
    addLog(`[Sistema] Cuenta "${oldName}" renombrada a "${account.name}".`);
    res.json({ success: true, name: account.name });
  } else {
    res.status(400).json({ success: false, error: 'Cuenta no encontrada o nombre inválido' });
  }
});

// Desvincular / Resetear cuenta
app.post('/api/accounts/unlink', async (req, res) => {
  const { id } = req.body;
  const account = config.accounts.find(acc => acc.id === id);
  if (account) {
    await unlinkAccount(id);
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: 'Cuenta no encontrada' });
  }
});

// Enviar ahora mismo
app.post('/api/send-now', async (req, res) => {
  if (isSending) {
    return res.status(409).json({ success: false, error: 'Ya hay un proceso de envio activo.' });
  }
  sendFromAllClients().catch(err => addLog(`Error inesperado al iniciar envio: ${err.message}`)); // Corre asíncronamente
  res.json({ success: true });
});

// Detener el envío actual
app.post('/api/stop-sending', (req, res) => {
  cancelRequested = true;
  isPaused = false;
  addLog('🛑 Petición de detención de envío recibida.');
  res.json({ success: true });
});

// Pausar el envío actual
app.post('/api/pause-sending', (req, res) => {
  isPaused = true;
  addLog('⏸️ Envío pausado por el usuario.');
  res.json({ success: true });
});

// Reanudar el envío actual
app.post('/api/resume-sending', (req, res) => {
  isPaused = false;
  addLog('▶️ Envío reanudado por el usuario.');
  res.json({ success: true });
});

// Obtener logs de la consola
app.get('/api/logs', (req, res) => {
  res.json({ logs: logLines });
});

// Endpoint temporal para exportar números de una etiqueta específica
// Verificar una etiqueta sin enviar mensajes.
app.post('/api/verify-label', async (req, res) => {
  const {
    accountId = 'cuenta_2',
    labelName,
    messageVariants,
    messageLimit,
    avoidIfLastMessageIsFromMe,
    checkHistory
  } = req.body || {};

  const account = config.accounts.find(acc => acc.id === accountId);
  const client = clients[accountId];
  if (!account) {
    return res.status(404).json({ success: false, error: 'Cuenta no encontrada.' });
  }
  if (!client) {
    return res.status(404).json({ success: false, error: `Cliente no encontrado para la cuenta ${accountId}.` });
  }
  const targetLabelName = (labelName || account.labelName || '').trim();
  if (!targetLabelName) {
    return res.status(400).json({ success: false, error: 'Escribe el nombre de la etiqueta a verificar.' });
  }

  const variants = Array.isArray(messageVariants)
    ? messageVariants.map(v => (v || '').toString().trim()).filter(Boolean)
    : getMessageVariants(account);
  const effectiveLimit = Number.parseInt(messageLimit, 10) || account.messageLimit || 0;
  const avoidLastFromMe = avoidIfLastMessageIsFromMe === true || avoidIfLastMessageIsFromMe === 'true';
  const shouldCheckHistory = checkHistory === true || checkHistory === 'true';

  addLog(`[Verificador] Revisando etiqueta "${targetLabelName}" en ${account.name}...`);

  try {
    const state = await withTimeout(client.getState(), OPERATION_TIMEOUT_MS, 'Tiempo de espera agotado al verificar estado de WhatsApp');
    if (state !== 'CONNECTED') {
      return res.status(400).json({ success: false, error: `WhatsApp no esta conectado todavia (estado: ${state}).` });
    }
    if (!statuses[accountId] || statuses[accountId].status !== 'READY') {
      statuses[accountId] = {
        ...(statuses[accountId] || {}),
        name: account.name,
        status: 'READY',
        qr: null,
        readyAt: Date.now()
      };
      addLog(`[Verificador] ${account.name} responde como CONNECTED; estado marcado como READY.`);
    }

    await waitForClientStable(account, client, 3, 2000);

    const labelLookup = await getLabelsWithFallback(client);
    const labels = labelLookup.labels;
    const availableLabels = labels.map(label => label.name).sort((a, b) => a.localeCompare(b));
    const matchingLabels = findMatchingLabels(labels, targetLabelName);

    if (matchingLabels.length === 0) {
      addLog(`[Verificador] No se encontro la etiqueta "${targetLabelName}".`);
      const emptyLabelMessage = labels.length === 0
        ? `WhatsApp Web no entrego ninguna etiqueta para ${account.name}. Si esta cuenta si tiene etiquetas, normalmente es porque no es WhatsApp Business, se escaneo otro telefono o WhatsApp Web todavia no termino de cargar las etiquetas.`
        : `No se encontro la etiqueta "${targetLabelName}".`;
      return res.status(404).json({
        success: false,
        error: emptyLabelMessage,
        availableLabels,
        labelSource: labelLookup.source,
        availableLabelCount: labels.length
      });
    }

    const labelChatGroups = [];
    for (const label of matchingLabels) {
      const getChatsPromise = (async () => {
        try {
          return await label.getChats();
        } catch (e) {
          return await getChatsByLabelIdSafe(client, label.id);
        }
      })();
      const labelChats = await withTimeout(getChatsPromise, OPERATION_TIMEOUT_MS, `Tiempo de espera agotado al obtener chats de "${label.name}"`);
      labelChatGroups.push({ label, chats: labelChats || [] });
    }

    const chatMap = new Map();
    for (const group of labelChatGroups) {
      for (const chat of group.chats) {
        const key = chat.id?._serialized || chat.id?.user || chat.name;
        if (key && !chatMap.has(key)) chatMap.set(key, chat);
      }
    }
    const chats = Array.from(chatMap.values());

    const summary = {
      success: true,
      accountId,
      accountName: account.name,
      label: matchingLabels.map(label => label.name).join(' + '),
      matchedLabels: labelChatGroups.map(group => ({ name: group.label.name, count: group.chats.length })),
      totalChats: chats.length,
      possibleToSend: 0,
      alreadySent: 0,
      skippedLastFromMe: 0,
      historyErrors: 0,
      messageLimit: effectiveLimit,
      estimatedBatches: 0,
      availableLabels,
      samplePossible: [],
      sampleSkipped: [],
      checkedHistory: shouldCheckHistory
    };

    if (!shouldCheckHistory) {
      summary.possibleToSend = chats.length;
      summary.estimatedBatches = effectiveLimit > 0 ? Math.ceil(summary.possibleToSend / effectiveLimit) : 1;
      summary.samplePossible = chats.slice(0, 12).map(chat => chat.name || chat.id?.user || 'Sin nombre');
      addLog(`[Verificador] "${targetLabelName}": ${summary.totalChats} chats unicos encontrados en ${matchingLabels.length} etiqueta(s).`);
      return res.json(summary);
    }

    const normalizedVariants = variants.map(v => v.trim()).filter(Boolean);
    for (const chat of chats) {
      const chatName = chat.name || chat.id?.user || 'Sin nombre';
      try {
        const messages = await withTimeout(
          chat.fetchMessages({ limit: 5 }),
          12000,
          `Tiempo de espera agotado al revisar historial de "${chatName}"`
        );
        const alreadySent = normalizedVariants.length > 0 && messages.some(msg =>
          msg.fromMe && normalizedVariants.some(variant => (msg.body || '').trim() === variant)
        );

        if (alreadySent) {
          summary.alreadySent++;
          if (summary.sampleSkipped.length < 12) summary.sampleSkipped.push({ name: chatName, reason: 'Ya recibio este mensaje' });
          continue;
        }

        const lastMessage = messages[messages.length - 1];
        if (avoidLastFromMe && lastMessage && lastMessage.fromMe) {
          summary.skippedLastFromMe++;
          if (summary.sampleSkipped.length < 12) summary.sampleSkipped.push({ name: chatName, reason: 'Ultimo mensaje enviado por la cuenta' });
          continue;
        }

        summary.possibleToSend++;
        if (summary.samplePossible.length < 12) summary.samplePossible.push(chatName);
      } catch (err) {
        summary.historyErrors++;
        if (summary.sampleSkipped.length < 12) summary.sampleSkipped.push({ name: chatName, reason: `No se pudo revisar historial: ${err.message}` });
      }
    }

    summary.estimatedBatches = effectiveLimit > 0 ? Math.ceil(summary.possibleToSend / effectiveLimit) : 1;
    addLog(`[Verificador] "${targetLabelName}": ${summary.possibleToSend}/${summary.totalChats} posibles para enviar.`);
    res.json(summary);
  } catch (err) {
    addLog(`[Verificador] Error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/export-label', async (req, res) => {
  const labelToFind = req.query.label || 'mayoreo';
  const accountId = req.query.accountId || 'cuenta_2'; // default bedrock
  
  addLog(`[Exportar] Buscando etiqueta "${labelToFind}" en la cuenta ${accountId}...`);
  
  const client = clients[accountId];
  if (!client) {
    return res.status(404).json({ success: false, error: `Cliente no encontrado para la cuenta ${accountId}` });
  }
  
  if (!statuses[accountId] || statuses[accountId].status !== 'READY') {
    return res.status(400).json({ success: false, error: `La cuenta ${accountId} no está conectada.` });
  }

  try {
    const labelLookup = await getLabelsWithFallback(client);
    const labels = labelLookup.labels;
    const targetLabel = findMatchingLabels(labels, labelToFind)[0];

    if (!targetLabel) {
      const labelNames = labels.map(l => l.name);
      addLog(`[Exportar] ❌ No se encontró la etiqueta "${labelToFind}". Etiquetas disponibles: ${labelNames.join(', ')}`);
      return res.status(404).json({ success: false, error: `No se encontró la etiqueta "${labelToFind}". Etiquetas disponibles: ${labelNames.join(', ')}` });
    }

    addLog(`[Exportar] ✅ Etiqueta encontrada: "${targetLabel.name}"`);
    
    let chats = [];
    try {
      chats = await targetLabel.getChats();
    } catch (e) {
      chats = await getChatsByLabelIdSafe(client, targetLabel.id);
    }

    if (!chats || chats.length === 0) {
      addLog(`[Exportar] No se encontraron chats con la etiqueta "${labelToFind}".`);
      return res.status(200).json({ success: true, count: 0, contacts: [] });
    }

    const contacts = chats.map(chat => ({
      name: chat.name || '',
      number: chat.id.user,
      serialized: chat.id._serialized
    }));

    // Escribir a TXT limpio (solo números)
    const txtContent = contacts.map(c => c.number).join('\n');
    const txtPath = path.join(__dirname, `numeros_${labelToFind.replace(/\s+/g, '_')}.txt`);

    fs.writeFileSync(txtPath, txtContent, 'utf8');

    addLog(`[Exportar] Guardados ${contacts.length} contactos de la etiqueta "${labelToFind}" en TXT.`);
    
    res.json({ success: true, count: contacts.length, label: targetLabel.name, contacts });
  } catch (err) {
    addLog(`[Exportar] ❌ Error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Apagar por completo el servidor y cerrar los navegadores Puppeteer
app.post('/api/shutdown', async (req, res) => {
  addLog('🛑 Petición de apagado del servidor recibida. Cerrando conexiones...');
  res.json({ success: true, message: 'El servidor se está apagando. Puedes cerrar esta pestaña.' });
  
  // Cerrar todos los clientes de WhatsApp de forma segura
  for (const accountId in clients) {
    try {
      await clients[accountId].destroy();
      addLog(`[Sistema] Navegador cerrado para la cuenta: ${accountId}`);
    } catch (err) {
      console.error(`Error al destruir cliente ${accountId}:`, err.message);
    }
  }

  // Finalizar el proceso de Node tras 1 segundo para asegurar el envío de la respuesta HTTP
  setTimeout(() => {
    addLog('👋 Servidor apagado. Saliendo del proceso.');
    process.exit(0);
  }, 1000);
});

// Middleware global de manejo de errores
app.use((err, req, res, next) => {
  addLog(`❌ Error detectado en el servidor: ${err.message}`);
  console.error(err);
  res.status(500).json({ success: false, error: err.message });
});

// Arrancar el Servidor Express.
// Si el puerto ya esta ocupado, significa que YA hay otra instancia del bot
// corriendo: cerramos esta para no duplicar y romper las sesiones.
const server = app.listen(PORT, () => {
  addLog(`🌐 Servidor web iniciado en http://localhost:${PORT}`);
  // Solo ahora, con el puerto asegurado, inicializamos las cuentas de WhatsApp.
  config.accounts.forEach(acc => {
    if (acc.enabled !== false) {
      initializeClient(acc);
    } else {
      statuses[acc.id] = {
        name: acc.name,
        status: 'DESACTIVADO',
        qr: null,
        readyAt: null
      };
      addLog(`[${acc.name}] Cuenta desactivada; no se inicia navegador.`);
    }
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[!] El bot YA esta corriendo (puerto ${PORT} ocupado).`);
    console.error('[!] Abre http://localhost:' + PORT + ' en tu navegador.');
    console.error('[!] No es necesario abrirlo de nuevo. Cerrando esta copia...\n');
    process.exit(0);
  } else {
    console.error('[!] Error al iniciar el servidor:', err.message);
    process.exit(1);
  }
});
