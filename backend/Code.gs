/**
 * Cartelería DIB — backend (Google Apps Script Web App)
 * Router principal. Toda petición entra por doGet/doPost y sale como JSON.
 *
 * Propiedades del script requeridas (Configuración del proyecto → Propiedades del script):
 *   APP_TOKEN            token que manda el frontend en ?t=   (obligatorio en producción)
 *   ERP_MOCK             "1" para responder con datos simulados sin tocar el ERP
 *   ERP_URL              https://tu-erp.cl            (solo si ERP_MOCK != 1)
 *   ERP_API_KEY          clave del ERP                 (solo si ERP_MOCK != 1)
 *   ERP_DB               nombre de la base (Odoo)      (opcional)
 *   LOG_SHEET_ID         id de una Google Sheet para log de uso (opcional)
 */
var VERSION = '1.0.0';

function doGet(e)  { return responder_(manejar_(e, 'GET')); }
function doPost(e) { return responder_(manejar_(e, 'POST')); }

function manejar_(e, metodo) {
  var t0 = Date.now();
  var p = {};
  try {
    p = metodo === 'POST' ? parsearBody_(e) : ((e && e.parameter) || {});
    var accion = String(p.action || '').toLowerCase();

    validarToken_(p);
    rateLimit_(p);

    var out;
    switch (accion) {
      case 'health':
        out = { ok: true, version: VERSION, hora: new Date().toISOString(), mock: esMock_() };
        break;
      case 'taxonomia':
        out = hTaxonomia_(validarTienda_(p), validarModo_(p));
        break;
      case 'buscar':
        out = hBuscar_(validarBuscar_(p));
        break;
      case 'producto':
        out = hProducto_(validarProducto_(p));
        break;
      case 'lote':
        if (metodo !== 'POST') throw err_('BAD_PARAM', 'lote requiere POST');
        out = hLote_(validarLote_(p));
        break;
      default:
        throw err_('BAD_PARAM', 'action inválida');
    }
    registrarUso_(p, out, Date.now() - t0);
    return out;
  } catch (ex) {
    var code = ex.code || 'INTERNO';
    registrarError_(code, ex.message, p);
    return { ok: false, error: { code: code, msg: mensajePublico_(code) } };
  }
}

function responder_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function parsearBody_(e) {
  try {
    var body = (e && e.postData && e.postData.contents) ? JSON.parse(e.postData.contents) : {};
    var merged = {};
    var k;
    for (k in (e.parameter || {})) merged[k] = e.parameter[k];
    for (k in body) merged[k] = body[k];
    return merged;
  } catch (_) { throw err_('BAD_PARAM', 'body inválido'); }
}

function err_(code, msg) { var x = new Error(msg || code); x.code = code; return x; }

function mensajePublico_(code) {
  var M = {
    BAD_PARAM: 'Parámetros inválidos.',
    TIENDA_DESCONOCIDA: 'Tienda no configurada.',
    CONSULTA_VACIA: 'Escribe al menos 2 letras o elige una línea.',
    LIMITE: 'Demasiados elementos en la consulta.',
    NO_ENCONTRADO: 'Producto no encontrado.',
    RATE_LIMIT: 'Demasiadas consultas, espera un momento.',
    NO_AUTORIZADO: 'Acceso no autorizado.',
    ERP_TIMEOUT: 'El ERP no respondió a tiempo. Reintenta.',
    ERP_ERROR: 'El ERP devolvió un error.',
    INTERNO: 'Error interno.'
  };
  return M[code] || M.INTERNO;
}
