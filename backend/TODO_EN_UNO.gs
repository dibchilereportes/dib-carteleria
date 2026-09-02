/* ============================================================
   Cartelería DIB — backend COMPLETO en un solo archivo.
   Pega esto en Código.gs y no necesitas ningún otro .gs.
   (Es la unión de Code, validar, erp, mapear, handlers, cache y mock)
   ============================================================ */

/* ===================== Code.gs ===================== */
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

/* ===================== validar.gs ===================== */
/**
 * Validación y sanitización de parámetros. Nada pasa al ERP sin salir de aquí.
 */

/** Espejo de config/tiendas.json: lo que el ERP necesita por tienda. */
var CONFIG_TIENDAS = {
  dib: { pricelist_id: 3, nombre: 'Tiendas DIB (CLP)', redondeo: 'peso' },
  sur: { pricelist_id: 7, nombre: 'Tiendas Sur',       redondeo: 'peso' }
};
var MODOS = ['general', 'descartados'];
var MOTIVOS_DESCARTE = ['SIN STOCK', 'DESCONTINUADO · FAMILIA', 'LINEA EXCLUIDA'];

var LIMITE_MAX = 100, LIMITE_DEF = 50, LOTE_MAX = 60, Q_MIN = 2, Q_MAX = 60;
var RL_POR_MINUTO = 90;

function props_() { return PropertiesService.getScriptProperties(); }
function esMock_() { return props_().getProperty('ERP_MOCK') === '1'; }

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

/* ===================== erp.gs ===================== */
/**
 * Cliente del ERP. ÚNICO archivo que conoce la URL, la API key y los nombres
 * de campos del ERP. Si cambia el ERP, se cambia solo este archivo.
 *
 * Todas las funciones erp*_ devuelven { records: [ {campos crudos del ERP} ] }.
 * Con ERP_MOCK=1 devuelven datos simulados (ver mock.gs).
 */

function erpProps_() {
  var sp = props_();
  return { url: sp.getProperty('ERP_URL'), key: sp.getProperty('ERP_API_KEY'), db: sp.getProperty('ERP_DB') };
}

/** Llamada genérica: timeout implícito de UrlFetchApp, 1 reintento, sin filtrar detalles al cliente. */
function erpFetch_(path, payload) {
  var cfg = erpProps_();
  if (!cfg.url || !cfg.key) throw err_('INTERNO', 'ERP no configurado (ERP_URL / ERP_API_KEY)');
  var opts = {
    method: 'post',
    contentType: 'application/json',
    // Ajustar al esquema de auth de tu ERP: Bearer, X-API-Key, o api_key en el body
    headers: { 'Authorization': 'Bearer ' + cfg.key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    followRedirects: false
  };
  var ultimo = null;
  for (var i = 0; i < 2; i++) {
    try {
      var r = UrlFetchApp.fetch(cfg.url.replace(/\/$/, '') + path, opts);
      var st = r.getResponseCode();
      if (st >= 200 && st < 300) return JSON.parse(r.getContentText());
      if (st === 401 || st === 403) throw err_('ERP_ERROR', 'auth ' + st);
      ultimo = err_('ERP_ERROR', 'HTTP ' + st + ' ' + r.getContentText().slice(0, 200));
    } catch (ex) {
      if (ex.code === 'ERP_ERROR' && /auth/.test(ex.message)) throw ex;
      ultimo = ex.code ? ex : err_('ERP_TIMEOUT', ex.message);
    }
    Utilities.sleep(300);
  }
  throw ultimo;
}

/* ------------------------------------------------------------------
   Consultas concretas. Los path/campos son ILUSTRATIVOS: cámbialos por
   los de la API que ya usas en tus otros proyectos de Apps Script.
   ------------------------------------------------------------------ */

function erpBuscarProductos_(f) {
  if (esMock_()) return mockBuscar_(f);
  var t = CONFIG_TIENDAS[f.tienda];
  var dominio = [['sale_ok', '=', true]];
  if (f.q) dominio.push('|', ['name', 'ilike', f.q], ['default_code', 'ilike', f.q]);
  if (f.linea)      dominio.push(['x_linea', '=', f.linea]);
  if (f.familia)    dominio.push(['x_familia', '=', f.familia]);
  if (f.subfamilia) dominio.push(['x_subfamilia', '=', f.subfamilia]);
  if (f.modo === 'general') dominio.push(['qty_available', '>', 0], ['active', '=', true]);
  return erpFetch_('/api/products/search', {
    domain: dominio,
    fields: CAMPOS_ERP,
    pricelist_id: t.pricelist_id,
    limit: f.limit * 6,
    offset: (f.pagina - 1) * f.limit * 6,
    order: 'name asc'
  });
}

function erpProductosPorGrupo_(f) {
  if (esMock_()) return mockPorGrupo_(f);
  var t = CONFIG_TIENDAS[f.tienda];
  return erpFetch_('/api/products/search', {
    domain: [['name', 'ilike', f.grupo], ['sale_ok', '=', true]],
    fields: CAMPOS_ERP, pricelist_id: t.pricelist_id, limit: 200, order: 'name asc'
  });
}

function erpProductoPorSku_(f) {
  if (esMock_()) return mockPorSkus_(f.tienda, [f.sku]);
  var t = CONFIG_TIENDAS[f.tienda];
  return erpFetch_('/api/products/search', {
    domain: [['default_code', '=', f.sku]],
    fields: CAMPOS_ERP, pricelist_id: t.pricelist_id, limit: 1
  });
}

function erpProductosPorSkus_(tienda, skus) {
  if (esMock_()) return mockPorSkus_(tienda, skus);
  var t = CONFIG_TIENDAS[tienda];
  return erpFetch_('/api/products/search', {
    domain: [['default_code', 'in', skus]],
    fields: CAMPOS_ERP, pricelist_id: t.pricelist_id, limit: skus.length
  });
}

function erpTaxonomia_(tienda) {
  if (esMock_()) return mockTaxonomia_();
  var t = CONFIG_TIENDAS[tienda];
  return erpFetch_('/api/categories/tree', { pricelist_id: t.pricelist_id });
}

/** Campos que se piden al ERP. Solo estos; nada de costo/margen/proveedor. */
var CAMPOS_ERP = [
  'default_code', 'name', 'x_variante', 'x_linea', 'x_familia', 'x_subfamilia',
  'list_price', 'x_descuento_pct', 'qty_available', 'active',
  'x_outlet', 'x_motivo_descarte', 'x_ppum_valor', 'x_ppum_unidad'
];

/* ===================== mapear.gs ===================== */
/**
 * ERP → DTO de impresión (whitelist). Todo lo que no está aquí NO sale del servidor.
 * También vive aquí la lógica de negocio que antes estaba duplicada en el HTML y el ETL:
 * nombre base (agrupado de variantes) y redondeo.
 */

function aProducto_(r, cfg) {
  var lista = Number(r.list_price) || 0;
  var dto = Number(r.x_descuento_pct) || 0;
  return {
    sku: String(r.default_code || ''),
    nombre: String(r.name || ''),
    descripcion: String(r.x_variante || ''),
    categoria: String(r.x_linea || ''),
    familia: String(r.x_familia || 'SIN FAMILIA'),
    subfamilia: String(r.x_subfamilia || 'SIN SUBFAMILIA'),
    precio_normal: lista,
    dto: dto,
    precio_oferta: redondear_(lista * (1 - dto / 100), (cfg && cfg.redondeo) || 'peso'),
    outlet: !!r.x_outlet,
    descontinuado: r.active === false,
    stock: (r.qty_available == null) ? null : Number(r.qty_available),
    motivo: String(r.x_motivo_descarte || ''),
    ppum_valor: r.x_ppum_valor == null ? null : Number(r.x_ppum_valor),
    ppum_unidad: String(r.x_ppum_unidad || '')
  };
}

/** Redondeo igual al HTML actual: 'peso' → entero; 'decena' → múltiplo de 10; '990' → termina en 990 */
function redondear_(n, modo) {
  n = Number(n) || 0;
  if (modo === 'decena') return Math.round(n / 10) * 10;
  if (modo === '990') return Math.max(990, Math.round((n + 10) / 1000) * 1000 - 10);
  return Math.round(n);
}

function norm_(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

/**
 * Nombre base del producto: quita medidas (133X190), tallas, colores y ruido,
 * para que "PLUMON TODA ESTACION 2P" y "PLUMON TODA ESTACION 1,5P" caigan
 * en el mismo grupo. Portar aquí la versión completa de parsearNombre() del HTML.
 */
var _MED    = /\b0*\d{2,4}\s*[xX]\s*0*\d{2,4}(?:\s*[xX]\s*0*\d{2,4})?\b/g;   /* 133X190, 200x300x2 */
var _PLAZAS = /\b\d+(?:[,.]\d+)?\s*(?:P|PL|PLZ|PLAZAS?|CUERPOS?|C)\b\.?/g;         /* 1,5 PLAZAS, 2P, 3 CUERPOS */
var _TALLA  = /\b(?:SUPER\s+KING|KING|QUEEN|XS|S|M|L|XL|XXL)\b/g;
var _NUM    = /\b\d+(?:[,.]\d+)?\b/g;                                              /* números sueltos */
var _COLORES = ('BLANCO BLANCA NEGRO NEGRA GRIS BEIGE CRUDO CRUDA NATURAL AZUL ROJO ROJA VERDE AMARILLO ' +
  'CAFE CHOCOLATE ROSA ROSADO CELESTE MOSTAZA TERRACOTA MARENGO PLOMO MARFIL ARENA TAUPE').split(' ');
function nombreBase_(nombre) {
  var s = norm_(nombre).replace(_MED, ' ').replace(_PLAZAS, ' ').replace(_TALLA, ' ').replace(_NUM, ' ');
  s = s.split(/[\s·,\/\-]+/).filter(function (w) { return w && _COLORES.indexOf(w) < 0; }).join(' ');
  return s.replace(/\s+/g, ' ').trim() || norm_(nombre);
}

/** Agrupa por nombre base y entrega resúmenes (lo único que ve el buscador) */
function agruparPorNombre_(items) {
  var g = {}, orden = [];
  items.forEach(function (p) {
    var k = nombreBase_(p.nombre);
    if (!g[k]) {
      g[k] = { nombre: k, linea: p.categoria, familia: p.familia, subfamilia: p.subfamilia,
               variantes: 0, desde: Infinity, hasta: 0, en_oferta: false, motivo: p.motivo || '' };
      orden.push(k);
    }
    var x = g[k];
    x.variantes++;
    x.desde = Math.min(x.desde, p.precio_oferta);
    x.hasta = Math.max(x.hasta, p.precio_oferta);
    x.en_oferta = x.en_oferta || p.dto > 0;
  });
  return orden.map(function (k) { return g[k]; });
}

function filtrarPorModo_(items, modo) {
  if (modo === 'descartados') {
    return items.filter(function (p) { return p.descontinuado || p.stock === 0 || !!p.motivo; })
      .map(function (p) { if (!p.motivo) p.motivo = p.descontinuado ? 'DESCONTINUADO · FAMILIA' : 'SIN STOCK'; return p; });
  }
  return items.filter(function (p) { return !p.descontinuado && (p.stock === null || p.stock > 0); });
}

/* ===================== handlers.gs ===================== */
/**
 * Handlers de cada action. Reciben parámetros ya validados, devuelven el JSON final.
 */

function hBuscar_(f) {
  var key = 'b:' + JSON.stringify(f);
  return conCache_(key, 120, function () {
    var raw = erpBuscarProductos_(f);
    var cfg = CONFIG_TIENDAS[f.tienda];
    var items = (raw.records || []).map(function (r) { return aProducto_(r, cfg); });
    items = filtrarPorModo_(items, f.modo);
    if (f.motivo) items = items.filter(function (p) { return p.motivo === f.motivo; });
    var grupos = agruparPorNombre_(items).slice(0, f.limit);
    return {
      ok: true, tienda: f.tienda, modo: f.modo, lista: cfg.nombre,
      fecha: new Date().toISOString(), total: grupos.length, grupos: grupos
    };
  });
}

function hProducto_(f) {
  var raw = f.sku ? erpProductoPorSku_(f) : erpProductosPorGrupo_(f);
  var cfg = CONFIG_TIENDAS[f.tienda];
  var items = (raw.records || []).map(function (r) { return aProducto_(r, cfg); });
  if (f.grupo) items = items.filter(function (p) { return nombreBase_(p.nombre) === norm_(f.grupo); });
  items = filtrarPorModo_(items, f.modo);
  if (!items.length) throw err_('NO_ENCONTRADO', f.grupo || f.sku);
  var legal = legalPara_(f.tienda, items);
  return {
    ok: true,
    tienda: f.tienda, modo: f.modo,
    grupo: f.grupo || nombreBase_(items[0].nombre),
    linea: items[0].categoria, familia: items[0].familia, subfamilia: items[0].subfamilia,
    legal: legal.texto, vig_desde: legal.desde, vig_hasta: legal.hasta,
    fecha: new Date().toISOString(),
    items: items
  };
}

function hLote_(f) {
  var raw = erpProductosPorSkus_(f.tienda, f.skus);
  var cfg = CONFIG_TIENDAS[f.tienda];
  var items = (raw.records || []).map(function (r) { return aProducto_(r, cfg); });
  var faltantes = f.skus.filter(function (s) { return !items.some(function (p) { return p.sku === s; }); });
  var legal = legalPara_(f.tienda, items);
  return { ok: true, tienda: f.tienda, fecha: new Date().toISOString(),
           legal: legal.texto, vig_desde: legal.desde, vig_hasta: legal.hasta,
           items: items, faltantes: faltantes };
}

function hTaxonomia_(tienda, modo) {
  return conCache_('tax:' + tienda + ':' + modo, 21600, function () {
    var raw = erpTaxonomia_(tienda);
    return {
      ok: true, tienda: tienda, modo: modo,
      niveles: modo === 'descartados'
        ? [{ campo: 'motivo', rotulo: 'Motivo del descarte' }, { campo: 'categoria', rotulo: 'Línea' },
           { campo: 'familia', rotulo: 'Familia' }, { campo: 'subfamilia', rotulo: 'Subfamilia' }]
        : [{ campo: 'categoria', rotulo: 'Línea' }, { campo: 'familia', rotulo: 'Familia' },
           { campo: 'subfamilia', rotulo: 'Subfamilia' }],
      arbol: raw.tree || [],
      motivos: modo === 'descartados' ? MOTIVOS_DESCARTE : []
    };
  });
}

/**
 * Texto legal y vigencia. Por defecto fijo; si defines LEGAL_SHEET_ID puede leerse
 * de una Sheet (hoja "legal", columnas: tienda | texto | vig_desde | vig_hasta).
 */
function legalPara_(tienda, items) {
  var base = { texto: 'Precios incluyen IVA. Válido hasta agotar stock.', desde: '', hasta: '' };
  var id = props_().getProperty('LEGAL_SHEET_ID');
  if (!id) return base;
  try {
    var rows = SpreadsheetApp.openById(id).getSheetByName('legal').getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][0]).toLowerCase() === tienda || String(rows[i][0]) === '*') {
        return { texto: String(rows[i][1] || base.texto), desde: fechaISO_(rows[i][2]), hasta: fechaISO_(rows[i][3]) };
      }
    }
  } catch (_) { /* si la sheet falla, se usa el texto base */ }
  return base;
}
function fechaISO_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'America/Santiago', 'yyyy-MM-dd');
  return String(v);
}

/* ===================== cache.gs ===================== */
/** Cache de respuestas (CacheService, máx 100 KB por entrada). */
function conCache_(clave, seg, fn) {
  var c = CacheService.getScriptCache();
  var k = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, clave));
  var hit = c.get(k);
  if (hit) return JSON.parse(hit);
  var val = fn();
  try { c.put(k, JSON.stringify(val), seg); } catch (_) { /* respuesta > 100 KB: no se cachea */ }
  return val;
}

/** Log de uso y errores en una Sheet (opcional: LOG_SHEET_ID). Nunca guarda precios. */
function registrarUso_(p, out, ms) {
  var id = props_().getProperty('LOG_SHEET_ID');
  if (!id) return;
  try {
    var n = out.grupos ? out.grupos.length : (out.items ? out.items.length : '');
    SpreadsheetApp.openById(id).getSheetByName('uso')
      .appendRow([new Date(), p.tienda || '', p.modo || '', p.action || '', p.q || p.grupo || '', n, ms]);
  } catch (_) {}
}
function registrarError_(code, msg, p) {
  console.error(code + ': ' + msg + ' | ' + JSON.stringify(p || {}));
  var id = props_().getProperty('LOG_SHEET_ID');
  if (!id) return;
  try {
    SpreadsheetApp.openById(id).getSheetByName('errores')
      .appendRow([new Date(), code, String(msg).slice(0, 300), (p && p.action) || '', (p && p.tienda) || '']);
  } catch (_) {}
}

/* ===================== mock.gs ===================== */
/**
 * Datos simulados para correr el sistema completo ANTES de conectar el ERP.
 * Se activa con la propiedad del script ERP_MOCK = 1. Borrar este archivo en producción si se quiere.
 */
var MOCK_PRODUCTOS = [
  { default_code: 'C619747-12905/2', name: 'ALFOMBRA ACCESS 133X190 CHOCOLATE', x_variante: '133X190 · CHOCOLATE', x_linea: 'ALFOMBRAS', x_familia: 'ALF. PP. HEAT SET', x_subfamilia: 'ALF. ACCESS-RYTMO/AHENK', list_price: 224780, x_descuento_pct: 55, qty_available: 1, active: true },
  { default_code: 'C617118-66202/3', name: 'ALFOMBRA ACCESS 133X190 GRIS NEGRO', x_variante: '133X190 · GRIS NEGRO', x_linea: 'ALFOMBRAS', x_familia: 'ALF. PP. HEAT SET', x_subfamilia: 'ALF. ACCESS-RYTMO/AHENK', list_price: 224780, x_descuento_pct: 50, qty_available: 20, active: true },
  { default_code: 'C617118-66201/4', name: 'ALFOMBRA ACCESS 160X230 GRIS NEGRO', x_variante: '160X230 · GRIS NEGRO', x_linea: 'ALFOMBRAS', x_familia: 'ALF. PP. HEAT SET', x_subfamilia: 'ALF. ACCESS-RYTMO/AHENK', list_price: 329990, x_descuento_pct: 50, qty_available: 3, active: true },
  { default_code: 'R610012-0000/00', name: 'PLUMON TODA ESTACION 1,5 PLAZAS', x_variante: '1,5 PLAZAS', x_linea: 'ROPA DE CAMA', x_familia: 'PLUMONES', x_subfamilia: 'PLUMON TODA ESTACION', list_price: 39990, x_descuento_pct: 30, qty_available: 14, active: true },
  { default_code: 'R610012-0000/02', name: 'PLUMON TODA ESTACION 2 PLAZAS', x_variante: '2 PLAZAS', x_linea: 'ROPA DE CAMA', x_familia: 'PLUMONES', x_subfamilia: 'PLUMON TODA ESTACION', list_price: 49990, x_descuento_pct: 30, qty_available: 9, active: true },
  { default_code: 'R610012-0000/0K', name: 'PLUMON TODA ESTACION KING', x_variante: 'KING', x_linea: 'ROPA DE CAMA', x_familia: 'PLUMONES', x_subfamilia: 'PLUMON TODA ESTACION', list_price: 59990, x_descuento_pct: 30, qty_available: 0, active: true },
  { default_code: 'K300100-0001/00', name: 'CORTINA ROLLER BLACKOUT 120X250 BLANCO', x_variante: '120X250 · BLANCO', x_linea: 'CORTINAS', x_familia: 'ROLLER', x_subfamilia: 'ROLLER BLACKOUT', list_price: 34990, x_descuento_pct: 0, qty_available: 12, active: true },
  { default_code: 'K300100-0001/01', name: 'CORTINA ROLLER BLACKOUT 150X250 BLANCO', x_variante: '150X250 · BLANCO', x_linea: 'CORTINAS', x_familia: 'ROLLER', x_subfamilia: 'ROLLER BLACKOUT', list_price: 42990, x_descuento_pct: 0, qty_available: 7, active: true },
  { default_code: 'M120001-0000/00', name: 'SOFA VENECIA 3 CUERPOS GRIS', x_variante: '3 CUERPOS · GRIS', x_linea: 'SOFAS', x_familia: 'SOFAS TELA', x_subfamilia: 'VENECIA', list_price: 499990, x_descuento_pct: 20, qty_available: 2, active: true },
  { default_code: 'B258217-0000/00', name: 'ALFOMBRA ARTESANAL KILIM 170X240', x_variante: '170X240', x_linea: 'ALFOMBRAS', x_familia: 'ALF. KELIMES', x_subfamilia: 'KILIM', list_price: 449990, x_descuento_pct: 80, qty_available: 1, active: false, x_motivo_descarte: 'DESCONTINUADO · FAMILIA' },
  { default_code: 'H900001-0000/00', name: 'TOALLA HOTELERA 70X140 BLANCO', x_variante: '70X140 · BLANCO', x_linea: 'HOTELERIA', x_familia: 'TOALLAS', x_subfamilia: 'TOALLA HOTELERA', list_price: 12990, x_descuento_pct: 0, qty_available: 40, active: true, x_motivo_descarte: 'LINEA EXCLUIDA · HOTELERIA' }
];

function mockBuscar_(f) {
  var q = norm_(f.q);
  var rec = MOCK_PRODUCTOS.filter(function (r) {
    var okQ = !q || norm_(r.name).indexOf(q) >= 0 || norm_(r.default_code).indexOf(q) >= 0;
    var okL = !f.linea || r.x_linea === f.linea;
    var okF = !f.familia || r.x_familia === f.familia;
    var okS = !f.subfamilia || r.x_subfamilia === f.subfamilia;
    return okQ && okL && okF && okS;
  });
  return { records: rec };
}
function mockPorGrupo_(f) {
  var g = norm_(f.grupo);
  return { records: MOCK_PRODUCTOS.filter(function (r) { return nombreBase_(r.name) === g; }) };
}
function mockPorSkus_(tienda, skus) {
  return { records: MOCK_PRODUCTOS.filter(function (r) { return skus.indexOf(r.default_code) >= 0; }) };
}
function mockTaxonomia_() {
  var tree = {};
  MOCK_PRODUCTOS.forEach(function (r) {
    tree[r.x_linea] = tree[r.x_linea] || {};
    tree[r.x_linea][r.x_familia] = tree[r.x_linea][r.x_familia] || {};
    tree[r.x_linea][r.x_familia][r.x_subfamilia] = 1;
  });
  return { tree: Object.keys(tree).map(function (l) {
    return { nombre: l, familias: Object.keys(tree[l]).map(function (fa) {
      return { nombre: fa, subfamilias: Object.keys(tree[l][fa]) }; }) };
  }) };
}
