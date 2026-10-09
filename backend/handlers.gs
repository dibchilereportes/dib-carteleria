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
    if (f.medida) items = items.filter(function (p) { return p.medida === f.medida; });
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

/** Rótulo de cada nivel posible, para pintar el encabezado de los chips. */
var ROTULOS_NIVEL = {
  motivo: 'Motivo del descarte', categoria: 'Línea', familia: 'Familia',
  subfamilia: 'Subfamilia', medida: 'Medida estándar'
};
/* Orden de navegación por tienda (modo "general"). La tienda que no está
   aquí usa el orden por defecto (Línea → Familia → Subfamilia).
   Decisión de operaciones del 9-oct-2026: las tres tiendas entran directo
   a Familia → Subfamilia → Medida estándar, sin el paso de Línea. Para
   dejar alguna con el orden anterior, basta sacarla de este mapa. */
var ORDEN_NAVEGACION = {
  dib:     ['familia', 'subfamilia', 'medida'],
  sur:     ['familia', 'subfamilia', 'medida'],
  bazhars: ['familia', 'subfamilia', 'medida']
};
var NIVELES_DEFECTO = ['categoria', 'familia', 'subfamilia'];

/**
 * Rutas distintas (según ORDEN_NAVEGACION) con cantidad de productos.
 * Es lo único "global" que recibe el navegador: ~700 filas cortas, sin precios ni SKU.
 */
/** Fracción mínima de productos con medida reconocible para que una
 *  familia+subfamilia use el nivel "medida" de verdad. Por debajo de esto,
 *  toda la rama queda en '—' y el frontend la salta sola (ver hTaxonomia_). */
var UMBRAL_MEDIDA = 0.5;

function hTaxonomia_(tienda, modo) {
  return conCache_('tax:' + tienda + ':' + modo, 21600, function () {
    var raw = erpTaxonomia_(tienda);
    var cfg = CONFIG_TIENDAS[tienda];
    var items = filtrarPorModo_((raw.records || []).map(function (r) { return aProducto_(r, cfg); }), modo);

    var campos = modo === 'descartados'
      ? ['motivo', 'categoria', 'familia', 'subfamilia']
      : (ORDEN_NAVEGACION[tienda] || NIVELES_DEFECTO);
    var niveles = campos.map(function (c) { return { campo: c, rotulo: ROTULOS_NIVEL[c] }; });

    /* "medida" se apaga por rama (familia+subfamilia) cuando casi ningún
       producto de esa rama trae una medida reconocible: evita un chip "—"
       con casi todo adentro, que no ayuda a decidir más rápido. */
    if (campos.indexOf('medida') >= 0) {
      var porRama = {};
      items.forEach(function (p) {
        var k = p.familia + '|' + p.subfamilia;
        if (!porRama[k]) porRama[k] = { total: 0, conMedida: 0 };
        porRama[k].total++;
        if (p.medida) porRama[k].conMedida++;
      });
      items.forEach(function (p) {
        var r = porRama[p.familia + '|' + p.subfamilia];
        if (!r.total || (r.conMedida / r.total) < UMBRAL_MEDIDA) p.medida = '';
      });
    }

    /* Si "familia" es un nivel pero "categoria" (línea) no lo es, una misma
       familia puede existir en más de una línea (ej. "Toallas" en Baño,
       Hotelería y Textil Hogar): sin desambiguar, sus productos se
       mezclarían en el mismo chip. Para las que chocan, se arma una
       etiqueta con la línea entre paréntesis SOLO para mostrar; "familia"
       sigue siendo el nombre real que entiende Odoo, así que el filtro no
       se rompe (el frontend recupera la familia real + la línea desde
       familia_etiqueta/familia_linea antes de pedir resultados). */
    var familiaEsNivel = campos.indexOf('familia') >= 0;
    var lineaEsNivel = campos.indexOf('categoria') >= 0;
    var familiasAmbiguas = {};
    if (familiaEsNivel && !lineaEsNivel) {
      var porFamilia = {};
      items.forEach(function (p) {
        if (!porFamilia[p.familia]) porFamilia[p.familia] = {};
        porFamilia[p.familia][p.categoria] = 1;
      });
      Object.keys(porFamilia).forEach(function (f) {
        if (Object.keys(porFamilia[f]).length > 1) familiasAmbiguas[f] = true;
      });
    }

    var m = {}, orden = [];
    items.forEach(function (p) {
      var ambigua = familiaEsNivel && !lineaEsNivel && familiasAmbiguas[p.familia || '—'];
      var valores = campos.map(function (c) {
        if (c === 'familia' && ambigua) return (p.familia || '—') + '\u0001' + p.categoria;  // solo para desduplicar filas
        return p[c] || '—';
      });
      var k = valores.join('|');
      if (!m[k]) {
        var fila = { n: 0 };
        campos.forEach(function (c, i) { fila[c] = c === 'familia' ? (p.familia || '—') : valores[i]; });
        if (ambigua) { fila.familia_etiqueta = (p.familia || '—') + ' (' + p.categoria + ')'; fila.familia_linea = p.categoria; }
        m[k] = fila; orden.push(k);
      }
      m[k].n++;
    });
    return {
      ok: true, tienda: tienda, modo: modo,
      niveles: niveles,
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
