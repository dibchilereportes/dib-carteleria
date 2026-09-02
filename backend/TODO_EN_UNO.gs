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


/* ===================== erp.gs ===================== */
/**
 * Cliente del ERP — Odoo por JSON-RPC.
 * ÚNICO archivo que conoce la URL, la BD, el usuario, la API key y los nombres de
 * campos de Odoo. Si cambia el ERP, se cambia solo este archivo.
 *
 * Todas las funciones erp*_ devuelven { records: [ {campos crudos de Odoo} ] }.
 * Con ERP_MOCK=1 (o sin credenciales) devuelven datos simulados (ver mock.gs).
 */

/* ------------------------------------------------------------------
   CREDENCIALES
   Opción A (rápida): rellena este bloque directamente en el editor de
   Apps Script. OJO: NO copies este archivo con la clave real a la carpeta
   del repositorio de GitHub (el repo es público).
   Opción B (recomendada a futuro): deja este bloque con los textos de
   ejemplo y crea las Propiedades del script ERP_URL, ERP_DB, ERP_USER,
   ERP_API_KEY. Si existen, mandan sobre lo escrito aquí.
   ------------------------------------------------------------------ */
var ODOO = {
  url:    'https://odooconsultores-dib.odoo.com', // URL base de tu instancia, SIN /jsonrpc al final
  db:     'NOMBRE_TECNICO_DE_LA_BD',              // el nombre técnico de BD que ya tienes
  user:   'TU_USUARIO_O_EMAIL',                   // usuario/login de Odoo
  apiKey: 'TU_API_KEY'                            // API key (Ajustes -> Mi perfil -> Seguridad de la cuenta -> Claves API)
};

/* ------------------------------------------------------------------
   MAPEO DE CAMPOS DE ODOO (product.product). Cambia aquí si tu instancia
   usa campos propios (x_...). Los de abajo son estándar de Odoo 14–17.
   ------------------------------------------------------------------ */
var ODOO_CAMPOS = {
  sku:      'default_code',   // referencia interna
  nombre:   'name',
  categ:    'categ_id',       // categoría (jerarquía "All / LÍNEA / FAMILIA / SUBFAMILIA")
  normal:   'list_price',     // precio de lista (sin descuento)
  vigente:  '',               // Odoo ≤16 tenía 'price' (precio por lista). En 17/18 no existe: vacío = se calcula con las reglas de la lista
  stock:    'qty_available',
  activo:   'active',
  motivo:   '',               // campo de motivo de descarte si lo tienes (ej. 'x_motivo_descarte'); vacío = se deduce
  outlet:   '',               // campo booleano de outlet si lo tienes; vacío = false
  linea:    'linea_id',       // módulo proandsys: Línea / Familia / Subfamilia (many2one)
  familia:  'familia_id',
  subfam:   'subfamilia_id',
  dcto_regla: 'proandsys_discount_line',  // % "Descuentos por Linea" en product.pricelist.item
  dcto_prod:  ''              // o bien campo propio de % descuento en product.product
};
var ODOO_MODELO = 'product.product';
/** Campos de las reglas de lista de precios (product.pricelist.item). Estándar en Odoo 14–18. */
var ODOO_REGLA = ['applied_on', 'product_id', 'product_tmpl_id', 'categ_id', 'compute_price', 'fixed_price',
                  'percent_price', 'price_discount', 'price_surcharge', 'base', 'min_quantity', 'date_start', 'date_end'];
/** Categorías raíz que no cuentan como "línea" al partir la jerarquía */
var ODOO_RAICES = ['All', 'Todos', 'Todo'];

function erpProps_() {
  var sp = props_();
  return {
    url:    (sp.getProperty('ERP_URL')     || ODOO.url    || '').replace(/\/+$/, ''),
    db:     sp.getProperty('ERP_DB')       || ODOO.db,
    user:   sp.getProperty('ERP_USER')     || ODOO.user,
    apiKey: sp.getProperty('ERP_API_KEY')  || ODOO.apiKey
  };
}
function credencialesListas_() {
  var c = erpProps_();
  return !!(c.url && c.db && c.user && c.apiKey &&
    c.db !== 'NOMBRE_TECNICO_DE_LA_BD' && c.user !== 'TU_USUARIO_O_EMAIL' && c.apiKey !== 'TU_API_KEY');
}

/* ------------------------------------------------------------------
   JSON-RPC
   ------------------------------------------------------------------ */
function rpc_(service, method, args) {
  var c = erpProps_();
  var payload = { jsonrpc: '2.0', method: 'call', id: Date.now(),
                  params: { service: service, method: method, args: args } };
  var opts = { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload),
               muteHttpExceptions: true, followRedirects: true };
  var ultimo = null;
  for (var i = 0; i < 2; i++) {
    try {
      var r = UrlFetchApp.fetch(c.url + '/jsonrpc', opts);
      var st = r.getResponseCode();
      if (st < 200 || st >= 300) { ultimo = err_('ERP_ERROR', 'HTTP ' + st); }
      else {
        var j = JSON.parse(r.getContentText());
        if (j.error) {
          var msg = (j.error.data && j.error.data.message) || j.error.message || 'error Odoo';
          throw err_('ERP_ERROR', msg.slice(0, 300));   // error de Odoo: no reintentar
        }
        return j.result;
      }
    } catch (ex) {
      if (ex.code === 'ERP_ERROR' && !/HTTP/.test(ex.message)) throw ex;
      ultimo = ex.code ? ex : err_('ERP_TIMEOUT', ex.message);
    }
    Utilities.sleep(300);
  }
  throw ultimo;
}

/** uid de Odoo (login con API key). Se cachea 6 h. */
function odooUid_() {
  var c = erpProps_();
  var cache = CacheService.getScriptCache();
  var k = 'uid:' + c.db + ':' + c.user;
  var hit = cache.get(k);
  if (hit) return Number(hit);
  var uid = rpc_('common', 'login', [c.db, c.user, c.apiKey]);
  if (!uid) throw err_('ERP_ERROR', 'auth: login/API key rechazados');
  cache.put(k, String(uid), 21600);
  return uid;
}

function odooCall_(modelo, metodo, args, kwargs) {
  var c = erpProps_();
  return rpc_('object', 'execute_kw', [c.db, odooUid_(), c.apiKey, modelo, metodo, args || [], kwargs || {}]);
}

function odooSearchRead_(modelo, dominio, campos, kwargs) {
  kwargs = kwargs || {};
  kwargs.fields = campos;
  return odooCall_(modelo, 'search_read', [dominio], kwargs);
}

/** id de la lista de precios por nombre (CONFIG_TIENDAS[t].nombre). Se cachea 6 h. */
function pricelistId_(tienda) {
  var t = CONFIG_TIENDAS[tienda];
  if (t.pricelist_id) return t.pricelist_id;
  var cache = CacheService.getScriptCache();
  var k = 'pl:' + tienda;
  var hit = cache.get(k);
  if (hit) return Number(hit);
  var rows = odooSearchRead_('product.pricelist', [['name', '=', t.nombre]], ['id', 'name'], { limit: 1 });
  if (!rows.length) throw err_('ERP_ERROR', 'lista de precios no encontrada: ' + t.nombre);
  cache.put(k, String(rows[0].id), 21600);
  return rows[0].id;
}

function camposProducto_() {
  var C = ODOO_CAMPOS;
  var out = [C.sku, C.nombre, C.categ, C.normal, C.stock, C.activo, 'product_tmpl_id', 'id'];
  if (C.vigente) out.push(C.vigente);
  if (C.motivo) out.push(C.motivo);
  if (C.outlet) out.push(C.outlet);
  if (C.linea) out.push(C.linea);
  if (C.familia) out.push(C.familia);
  if (C.subfam) out.push(C.subfam);
  if (C.dcto_prod) out.push(C.dcto_prod);
  return out;
}
function camposRegla_() { return ODOO_CAMPOS.dcto_regla ? ODOO_REGLA.concat([ODOO_CAMPOS.dcto_regla]) : ODOO_REGLA; }

function buscarProductos_(tienda, dominio, kwargs) {
  kwargs = kwargs || {};
  kwargs.context = { pricelist: pricelistId_(tienda), active_test: false };
  var rows = odooSearchRead_(ODOO_MODELO, dominio, camposProducto_(), kwargs);
  if (!ODOO_CAMPOS.vigente) aplicarReglasLista_(tienda, rows);
  return { records: rows.map(aRegistroErp_) };
}

/* ------------------------------------------------------------------
   Precio por lista de precios calculado con sus reglas (Odoo 17/18).
   Prioridad: regla por variante > por plantilla > por categoría > global.
   Solo se piden las reglas que afectan a los productos de la consulta.
   ------------------------------------------------------------------ */
function aplicarReglasLista_(tienda, rows) {
  if (!rows.length) return;
  var plid = pricelistId_(tienda);
  var ids = rows.map(function (r) { return r.id; });
  var tmpl = rows.map(function (r) { return Array.isArray(r.product_tmpl_id) ? r.product_tmpl_id[0] : r.product_tmpl_id; });
  var dominio = [['pricelist_id', '=', plid], '|', '|', '|',
                 ['product_id', 'in', ids], ['product_tmpl_id', 'in', tmpl],
                 ['applied_on', '=', '2_product_category'], ['applied_on', '=', '3_global']];
  var reglas = odooSearchRead_('product.pricelist.item', dominio, camposRegla_(), { limit: 5000 });
  var hoy = Utilities.formatDate(new Date(), 'America/Santiago', 'yyyy-MM-dd');
  reglas = reglas.filter(function (g) {
    if (g.min_quantity && g.min_quantity > 1) return false;
    if (g.date_start && String(g.date_start).slice(0, 10) > hoy) return false;
    if (g.date_end && String(g.date_end).slice(0, 10) < hoy) return false;
    return true;
  });
  var porVar = {}, porTmpl = {}, porCat = [], global = null;
  reglas.forEach(function (g) {
    var ap = g.applied_on;
    if (ap === '0_product_variant' && g.product_id) porVar[g.product_id[0]] = porVar[g.product_id[0]] || g;
    else if (ap === '1_product' && g.product_tmpl_id) porTmpl[g.product_tmpl_id[0]] = porTmpl[g.product_tmpl_id[0]] || g;
    else if (ap === '2_product_category' && g.categ_id) porCat.push(g);
    else if (ap === '3_global') global = global || g;
  });
  rows.forEach(function (r) {
    var t = Array.isArray(r.product_tmpl_id) ? r.product_tmpl_id[0] : r.product_tmpl_id;
    var catNombre = Array.isArray(r[ODOO_CAMPOS.categ]) ? String(r[ODOO_CAMPOS.categ][1]) : '';
    var regla = porVar[r.id] || porTmpl[t] || null;
    if (!regla) {
      /* categoría: la regla aplica si su categoría es la del producto o una madre (prefijo de la ruta) */
      var mejor = null;
      porCat.forEach(function (g) {
        var cn = String(g.categ_id[1]);
        if (catNombre === cn || catNombre.indexOf(cn + ' / ') === 0) {
          if (!mejor || cn.length > String(mejor.categ_id[1]).length) mejor = g;
        }
      });
      regla = mejor || global;
    }
    var lista = Number(r[ODOO_CAMPOS.normal]) || 0;
    /* En esta instancia el precio de tienda ES el precio fijo de la regla: pasa a ser el "normal" */
    if (regla && regla.compute_price === 'fixed') { r.x_precio_lista = Number(regla.fixed_price) || 0; r.x_precio_vigente = r.x_precio_lista; }
    else r.x_precio_vigente = precioPorRegla_(regla, lista);
    r.x_sin_lista = !regla;   /* sin regla en esta lista = no se vende en esta tienda */
    /* descuento por línea/familia (campo propio en la regla o en el producto), si está configurado */
    var d = ODOO_CAMPOS.dcto_regla && regla ? Number(regla[ODOO_CAMPOS.dcto_regla]) : 0;
    if (!d && ODOO_CAMPOS.dcto_prod) d = Number(r[ODOO_CAMPOS.dcto_prod]) || 0;
    if (d > 0) r.x_precio_vigente = (r.x_precio_lista != null ? r.x_precio_lista : r.x_precio_vigente) * (1 - d / 100);
  });
}
function precioPorRegla_(g, lista) {
  if (!g) return lista;
  if (g.compute_price === 'fixed') return Number(g.fixed_price) || 0;
  if (g.compute_price === 'percentage') return lista * (1 - (Number(g.percent_price) || 0) / 100);
  /* formula: base list_price (otras bases —costo/otra lista— se aproximan con el precio de lista) */
  return lista * (1 - (Number(g.price_discount) || 0) / 100) + (Number(g.price_surcharge) || 0);
}

/** valor legible de un many2one ([id, "Nombre"]) o de un char/selection */
function m2o_(v) { return Array.isArray(v) ? String(v[1] || '') : (v == null || v === false ? '' : String(v)); }

/** Odoo → registro plano con nombres neutros (los que consume mapear.gs) */
function aRegistroErp_(r) {
  var C = ODOO_CAMPOS;
  var categ = r[C.categ];                                   // [id, "All / ALFOMBRAS / ALF. PP / ACCESS"]
  var ruta = (Array.isArray(categ) ? String(categ[1]) : String(categ || ''))
    .split(' / ').map(function (s) { return s.trim(); })
    .filter(function (s) { return s && ODOO_RAICES.indexOf(s) < 0; });
  var normal = r.x_precio_lista != null ? Number(r.x_precio_lista) : (Number(r[C.normal]) || 0);
  var vigente = r.x_precio_vigente != null ? Number(r.x_precio_vigente)
              : (C.vigente && r[C.vigente] != null ? Number(r[C.vigente]) : normal);
  var dto = (normal > 0 && vigente < normal) ? Math.round((1 - vigente / normal) * 100) : 0;
  return {
    default_code: r[C.sku] || '',
    name: r[C.nombre] || '',
    x_variante: '',
    x_linea: (C.linea && m2o_(r[C.linea])) || ruta[0] || 'SIN LINEA',
    x_sin_lista: !!r.x_sin_lista,
    x_familia: (C.familia && m2o_(r[C.familia])) || ruta[1] || 'SIN FAMILIA',
    x_subfamilia: (C.subfam && m2o_(r[C.subfam])) || ruta[2] || 'SIN SUBFAMILIA',
    list_price: normal,
    x_precio_vigente: vigente,
    x_descuento_pct: dto,
    qty_available: r[C.stock],
    active: r[C.activo] !== false,
    x_outlet: C.outlet ? !!r[C.outlet] : false,
    x_motivo_descarte: C.motivo ? (r[C.motivo] || '') : ''
  };
}

/* ------------------------------------------------------------------
   Consultas que usa handlers.gs
   ------------------------------------------------------------------ */
function erpBuscarProductos_(f) {
  if (esMock_()) return mockBuscar_(f);
  var C = ODOO_CAMPOS;
  var dominio = [['sale_ok', '=', true]];
  if (f.q) dominio.push('|', [C.nombre, 'ilike', f.q], [C.sku, 'ilike', f.q]);
  if (f.linea)      dominio.push(C.linea   ? [C.linea + '.name', '=', f.linea]        : [C.categ + '.complete_name', 'ilike', '/ ' + f.linea]);
  if (f.familia)    dominio.push(C.familia ? [C.familia + '.name', '=', f.familia]    : [C.categ + '.complete_name', 'ilike', '/ ' + f.familia]);
  if (f.subfamilia) dominio.push(C.subfam  ? [C.subfam + '.name', '=', f.subfamilia] : [C.categ + '.complete_name', 'ilike', '/ ' + f.subfamilia]);
  if (f.modo === 'general') dominio.push([C.stock, '>', 0], [C.activo, '=', true]);
  return buscarProductos_(f.tienda, dominio, {
    limit: f.limit * 6, offset: (f.pagina - 1) * f.limit * 6, order: C.nombre + ' asc'
  });
}

function erpProductosPorGrupo_(f) {
  if (esMock_()) return mockPorGrupo_(f);
  /* trae todo lo que empiece por el nombre base; el handler filtra por grupo exacto */
  var primera = String(f.grupo).split(' ').slice(0, 2).join(' ');
  return buscarProductos_(f.tienda, [[ODOO_CAMPOS.nombre, 'ilike', primera], ['sale_ok', '=', true]],
    { limit: 300, order: ODOO_CAMPOS.nombre + ' asc' });
}

function erpProductoPorSku_(f) {
  if (esMock_()) return mockPorSkus_(f.tienda, [f.sku]);
  return buscarProductos_(f.tienda, [[ODOO_CAMPOS.sku, '=', f.sku]], { limit: 1 });
}

function erpProductosPorSkus_(tienda, skus) {
  if (esMock_()) return mockPorSkus_(tienda, skus);
  return buscarProductos_(tienda, [[ODOO_CAMPOS.sku, 'in', skus]], { limit: skus.length });
}

/** Jerarquía: SOLO campos de clasificación (sin precio ni SKU); se agrega en el servidor. */
function erpTaxonomia_(tienda) {
  if (esMock_()) return mockTaxonomia_();
  var C = ODOO_CAMPOS;
  var campos = [C.nombre, C.categ, C.stock, C.activo, 'product_tmpl_id', 'id'];
  if (C.motivo) campos.push(C.motivo);
  if (C.linea) campos.push(C.linea);
  if (C.familia) campos.push(C.familia);
  if (C.subfam) campos.push(C.subfam);
  var rows = odooSearchRead_(ODOO_MODELO, [['sale_ok', '=', true]], campos,
    { limit: 20000, context: { active_test: false } });
  /* plantillas con regla en esta lista (solo ids, sin precios) */
  var reglas = odooSearchRead_('product.pricelist.item', [['pricelist_id', '=', pricelistId_(tienda)]],
    ['product_tmpl_id', 'product_id'], { limit: 50000 });
  var conRegla = {};
  reglas.forEach(function (g) { if (g.product_tmpl_id) conRegla['t' + g.product_tmpl_id[0]] = 1; if (g.product_id) conRegla['p' + g.product_id[0]] = 1; });
  rows.forEach(function (r) {
    var t = Array.isArray(r.product_tmpl_id) ? r.product_tmpl_id[0] : r.product_tmpl_id;
    r.x_sin_lista = !(conRegla['t' + t] || conRegla['p' + r.id]);
  });
  return { records: rows.map(aRegistroErp_) };
}

/* ------------------------------------------------------------------
   PRUEBA DESDE EL EDITOR: elige pruebaOdoo en el desplegable y ▶ Ejecutar.
   Muestra en el registro si las credenciales sirven, las listas de precio
   disponibles y 5 productos de ejemplo con su precio por lista.
   ------------------------------------------------------------------ */
function pruebaOdoo() {
  if (!credencialesListas_()) { Logger.log('Faltan credenciales: rellena ODOO{...} o las Propiedades del script'); return; }
  var uid = odooUid_();
  Logger.log('Login OK, uid=' + uid);
  var listas = odooSearchRead_('product.pricelist', [], ['id', 'name'], { limit: 50 });
  Logger.log('Listas de precio: ' + JSON.stringify(listas));
  var t = Object.keys(CONFIG_TIENDAS)[0];
  var reglas = odooSearchRead_('product.pricelist.item', [['pricelist_id', '=', pricelistId_(t)]], ODOO_REGLA, { limit: 5 });
  Logger.log('Reglas de la lista ' + t + ' (5 de ejemplo): ' + JSON.stringify(reglas));
  var r = buscarProductos_(t, [['sale_ok', '=', true], [ODOO_CAMPOS.stock, '>', 0]], { limit: 5 });
  Logger.log('Ejemplo (' + t + '): ' + JSON.stringify(r.records));
}

/* ------------------------------------------------------------------
   DIAGNÓSTICO DE CAMPOS: elige diagnosticoCampos y ▶ Ejecutar. Lista los
   campos propios (x_...) y los que suenan a familia/descuento/motivo en
   product.product, product.template y product.pricelist.item, para
   rellenar ODOO_CAMPOS.
   ------------------------------------------------------------------ */
function diagnosticoCampos() {
  var modelos = ['product.product', 'product.template', 'product.pricelist.item'];
  var pat = /^x_|famil|subfam|linea|línea|desc|dcto|motivo|outlet|descont|catalog/i;
  modelos.forEach(function (m) {
    var f = odooCall_(m, 'fields_get', [], { attributes: ['string', 'type', 'relation'] });
    var out = Object.keys(f).filter(function (k) { return pat.test(k) || pat.test(f[k].string || ''); })
      .map(function (k) { return k + ' (' + f[k].type + (f[k].relation ? '→' + f[k].relation : '') + ') "' + f[k].string + '"'; });
    Logger.log(m + ':\n  ' + out.join('\n  '));
  });
  /* además: un producto real con TODOS sus campos x_ para ver valores */
  var f2 = odooCall_('product.product', 'fields_get', [], { attributes: ['type'] });
  var xs = Object.keys(f2).filter(function (k) { return /^x_/.test(k); });
  var p = odooSearchRead_('product.product', [['sale_ok', '=', true], ['qty_available', '>', 0]], ['default_code', 'name', 'categ_id'].concat(xs), { limit: 2 });
  Logger.log('Ejemplo con campos x_: ' + JSON.stringify(p));
}


/* ===================== mapear.gs ===================== */
/**
 * ERP → DTO de impresión (whitelist). Todo lo que no está aquí NO sale del servidor.
 * También vive aquí la lógica de negocio que antes estaba duplicada en el HTML y el ETL:
 * nombre base (agrupado de variantes) y redondeo.
 */

function aProducto_(r, cfg) {
  var lista = Number(r.list_price) || 0;
  var dto = Number(r.x_descuento_pct) || 0;
  var nombre = String(r.name || '');
  return {
    sku: String(r.default_code || ''),
    nombre: nombre,
    descripcion: String(r.x_variante || '') || variante_(nombre),
    categoria: String(r.x_linea || ''),
    familia: String(r.x_familia || 'SIN FAMILIA'),
    subfamilia: String(r.x_subfamilia || 'SIN SUBFAMILIA'),
    precio_normal: lista,
    dto: dto,
    precio_oferta: redondear_(r.x_precio_vigente != null ? Number(r.x_precio_vigente) : lista * (1 - dto / 100), (cfg && cfg.redondeo) || 'peso'),
    outlet: !!r.x_outlet,
    descontinuado: r.active === false,
    stock: (r.qty_available == null) ? null : Number(r.qty_available),
    motivo: String(r.x_motivo_descarte || ''),
    sin_lista: !!r.x_sin_lista,
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

/** Lo que queda del nombre al quitar el nombre base: "133X190 GRIS NEGRO" */
function variante_(nombre) {
  var base = nombreBase_(nombre).split(' ');
  var out = norm_(nombre).split(/\s+/).filter(function (w) { return w && base.indexOf(w) < 0; });
  return out.join(' ');
}

/** Líneas donde cada modelo va en su propia tarjeta (no se agrupan por nombre base) */
var LINEAS_SIN_AGRUPAR = ['SOFAS'];
function claveGrupo_(p) {
  return LINEAS_SIN_AGRUPAR.indexOf(norm_(p.categoria)) >= 0 ? norm_(p.nombre) : nombreBase_(p.nombre);
}

/** Agrupa por nombre base y entrega resúmenes (lo único que ve el buscador) */
function agruparPorNombre_(items) {
  var g = {}, orden = [];
  items.forEach(function (p) {
    var k = claveGrupo_(p);
    if (!g[k]) {
      g[k] = { nombre: k, linea: p.categoria, familia: p.familia, subfamilia: p.subfamilia,
               variantes: 0, desde: Infinity, hasta: 0, normal: p.precio_normal, en_oferta: false, dto_max: 0,
               sku: p.sku, descripcion: p.descripcion, skus: [], medidas: [], motivo: p.motivo || '' };
      orden.push(k);
    }
    var x = g[k];
    x.variantes++;
    x.skus.push(p.sku);
    var med = String(p.descripcion || '').split(' · ')[0];
    if (med && x.medidas.indexOf(med) < 0 && x.medidas.length < 4) x.medidas.push(med);
    x.desde = Math.min(x.desde, p.precio_oferta);
    x.hasta = Math.max(x.hasta, p.precio_oferta);
    if (p.dto > 0 && p.precio_oferta < p.precio_normal) { x.en_oferta = true; x.dto_max = Math.max(x.dto_max, p.dto); }
  });
  return orden.map(function (k) { return g[k]; });
}

function filtrarPorModo_(items, modo) {
  /* Fuera de la lista general: sin regla en la lista de precios de la tienda, sin precio, descontinuado o sin stock */
  if (modo === 'descartados') {
    return items.filter(function (p) { return p.sin_lista || p.precio_normal <= 0 || p.descontinuado || p.stock === 0 || !!p.motivo; })
      .map(function (p) {
        if (!p.motivo) p.motivo = p.sin_lista ? 'SIN PRECIO EN LISTA' : p.precio_normal <= 0 ? 'PRECIO CERO'
                                : p.descontinuado ? 'DESCONTINUADO' : 'SIN STOCK';
        return p;
      });
  }
  return items.filter(function (p) { return !p.sin_lista && p.precio_normal > 0 && !p.descontinuado && (p.stock === null || p.stock > 0); });
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
  if (f.grupo) items = items.filter(function (p) { return claveGrupo_(p) === norm_(f.grupo); });
  items = filtrarPorModo_(items, f.modo);
  if (!items.length) throw err_('NO_ENCONTRADO', f.grupo || f.sku);
  var legal = legalPara_(f.tienda, items);
  return {
    ok: true,
    tienda: f.tienda, modo: f.modo,
    grupo: f.grupo || claveGrupo_(items[0]),
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

/**
 * Rutas distintas (motivo/línea/familia/subfamilia) con cantidad de productos.
 * Es lo único "global" que recibe el navegador: ~700 filas cortas, sin precios ni SKU.
 */
function hTaxonomia_(tienda, modo) {
  return conCache_('tax:' + tienda + ':' + modo, 21600, function () {
    var raw = erpTaxonomia_(tienda);
    var cfg = CONFIG_TIENDAS[tienda];
    var items = filtrarPorModo_((raw.records || []).map(function (r) { return aProducto_(r, cfg); }), modo);
    var m = {}, orden = [];
    items.forEach(function (p) {
      var k = [p.motivo, p.categoria, p.familia, p.subfamilia].join('|');
      if (!m[k]) { m[k] = { motivo: p.motivo, categoria: p.categoria, familia: p.familia, subfamilia: p.subfamilia, n: 0 }; orden.push(k); }
      m[k].n++;
    });
    return {
      ok: true, tienda: tienda, modo: modo,
      niveles: modo === 'descartados'
        ? [{ campo: 'motivo', rotulo: 'Motivo del descarte' }, { campo: 'categoria', rotulo: 'Línea' },
           { campo: 'familia', rotulo: 'Familia' }, { campo: 'subfamilia', rotulo: 'Subfamilia' }]
        : [{ campo: 'categoria', rotulo: 'Línea' }, { campo: 'familia', rotulo: 'Familia' },
           { campo: 'subfamilia', rotulo: 'Subfamilia' }],
      rutas: orden.map(function (k) { return m[k]; })
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
function mockPorGrupo_(f) { return { records: MOCK_PRODUCTOS }; }   /* el handler filtra por grupo */
function mockPorSkus_(tienda, skus) {
  return { records: MOCK_PRODUCTOS.filter(function (r) { return skus.indexOf(r.default_code) >= 0; }) };
}
function mockTaxonomia_() { return { records: MOCK_PRODUCTOS }; }
