/**
 * Validación y sanitización de parámetros. Nada pasa al ERP sin salir de aquí.
 */

/** Espejo de config/tiendas.json: lo que el ERP necesita por tienda. */
/* nombre = nombre EXACTO de la lista de precios en Odoo (Ventas → Listas de precios).
   pricelist_id: déjalo en null y se busca por nombre; o pon el id numérico si lo conoces. */
var CONFIG_TIENDAS = {
  dib: { pricelist_id: 24894, nombre: 'Tiendas DIB', redondeo: 'peso' },
  sur: { pricelist_id: 24983, nombre: 'Tiendas Sur', redondeo: 'peso' }
};
var MODOS = ['general', 'descartados'];
var MOTIVOS_DESCARTE = ['SIN STOCK', 'DESCONTINUADO', 'SIN PRECIO EN LISTA', 'PRECIO CERO'];

var LIMITE_MAX = 100, LIMITE_DEF = 50, LOTE_MAX = 60, Q_MIN = 2, Q_MAX = 60;
var RL_POR_MINUTO = 90;

function props_() { return PropertiesService.getScriptProperties(); }
/** Modo simulado: si ERP_MOCK=1, o si todavía no hay ERP_URL configurada. Sin propiedades → simulado. */
function esMock_() {
  var m = props_().getProperty('ERP_MOCK');
  if (m === '1') return true;
  if (m === '0') return false;
  return !credencialesListas_();   /* sin credenciales reales → simulado */
}

function limpiar_(s, max) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .replace(/[<>"'`;\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function validarToken_(p) {
  var esperado = props_().getProperty('APP_TOKEN');
  if (!esperado) return;                       // sin token configurado = modo desarrollo
  if (String(p.t || '') !== esperado) throw err_('NO_AUTORIZADO', 'token');
}

function rateLimit_(p) {
  var c = CacheService.getScriptCache();
  var k = 'rl:' + limpiar_(p.tienda || 'x', 20) + ':' + Math.floor(Date.now() / 60000);
  var n = Number(c.get(k) || 0) + 1;
  c.put(k, String(n), 90);
  if (n > RL_POR_MINUTO) throw err_('RATE_LIMIT', k);
}

function validarTienda_(p) {
  var t = limpiar_(p.tienda, 20).toLowerCase();
  if (!CONFIG_TIENDAS[t]) throw err_('TIENDA_DESCONOCIDA', t);
  return t;
}

function validarModo_(p) {
  var m = limpiar_(p.modo || 'general', 20).toLowerCase();
  if (MODOS.indexOf(m) < 0) throw err_('BAD_PARAM', 'modo');
  return m;
}

function validarBuscar_(p) {
  var out = {
    tienda: validarTienda_(p),
    modo: validarModo_(p),
    q: limpiar_(p.q, Q_MAX),
    linea: limpiar_(p.linea, 60),
    familia: limpiar_(p.familia, 60),
    subfamilia: limpiar_(p.subfamilia, 60),
    motivo: limpiar_(p.motivo, 60),
    limit: Math.min(LIMITE_MAX, Math.max(1, parseInt(p.limit, 10) || LIMITE_DEF)),
    pagina: Math.max(1, parseInt(p.pagina, 10) || 1)
  };
  if (out.q.length < Q_MIN && !out.linea && !out.motivo) throw err_('CONSULTA_VACIA', 'falta q o linea');
  return out;
}

function validarProducto_(p) {
  var out = {
    tienda: validarTienda_(p),
    modo: validarModo_(p),
    grupo: limpiar_(p.grupo, 120),
    sku: limpiar_(p.sku, 40)
  };
  if (!out.grupo && !out.sku) throw err_('BAD_PARAM', 'grupo o sku');
  return out;
}

function validarLote_(p) {
  var lista = p.skus;
  if (typeof lista === 'string') lista = lista.split(',');
  if (!Array.isArray(lista)) lista = [];
  var skus = [], vistos = {};
  lista.forEach(function (s) {
    var v = limpiar_(s, 40);
    if (v && !vistos[v]) { vistos[v] = 1; skus.push(v); }
  });
  if (!skus.length) throw err_('BAD_PARAM', 'skus vacío');
  if (skus.length > LOTE_MAX) throw err_('LIMITE', 'máx ' + LOTE_MAX);
  return { tienda: validarTienda_(p), skus: skus };
}
