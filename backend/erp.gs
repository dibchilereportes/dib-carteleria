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
