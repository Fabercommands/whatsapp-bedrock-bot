// Reaplica un arreglo de whatsapp-web.js despues de cada `npm install`.
//
// La version fijada en package-lock.json no lo trae. Sin el, desde la
// actualizacion de WhatsApp Web del 12 de octubre de 2026, todo envio con
// archivo (PDF, imagen, nota de voz) falla con:
//   "Data passed to getter must include an id property ... but got undefined"
// Los mensajes de solo texto no se ven afectados.
//
// Arreglo oficial: https://github.com/wwebjs/whatsapp-web.js/pull/201923
// Si algun dia se actualiza whatsapp-web.js a una version que ya lo incluye,
// este script lo detecta y no hace nada.

const fs = require('fs');
const path = require('path');

const utilsPath = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
const YA_ARREGLADO = 'delete message.__x_id';
const ANCLA = "        // Bot's won't reply if canonicalUrl is set (linking)";
const ARREGLO = [
  "        // MediaData is a model whose private __x_id field collides with Msg's",
  '        // internal id field when its enumerable properties are spread above,',
  '        // breaking getValidatedSender() during Msg initialization.',
  '        if (message.__x_id) {',
  '            delete message.__x_id;',
  '        }',
  '',
  '',
].join('\n');

if (!fs.existsSync(utilsPath)) {
  console.error('[parche] No existe ' + utilsPath + '. Corre npm install primero.');
  process.exit(1);
}

const codigo = fs.readFileSync(utilsPath, 'utf8');

if (codigo.includes(YA_ARREGLADO)) {
  console.log('[parche] whatsapp-web.js ya tiene el arreglo de envio de archivos.');
  process.exit(0);
}

// Fallar fuerte: instalar sin el arreglo deja un bot que "funciona" pero no
// manda ningun PDF, y eso solo se nota en medio de una campana.
if (codigo.split(ANCLA).length !== 2) {
  console.error('[parche] No encontre donde aplicar el arreglo en whatsapp-web.js.');
  console.error('[parche] La libreria cambio; revisa el PR 201923 y aplicalo a mano.');
  process.exit(1);
}

fs.writeFileSync(utilsPath, codigo.replace(ANCLA, ARREGLO + ANCLA), 'utf8');
console.log('[parche] Arreglo de envio de archivos aplicado a whatsapp-web.js.');
