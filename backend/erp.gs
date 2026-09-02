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
