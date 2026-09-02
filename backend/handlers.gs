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
