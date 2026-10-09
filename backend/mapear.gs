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
    medida: medidaEstandar_(nombre),
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

/** Medida estándar (ej. "160X230") para navegar/filtrar por tamaño. Misma
 *  regla que usa el frontend (_MED en app.js) para que ambos lados calcen;
 *  si el nombre no trae una medida reconocible, vuelve ''. */
var _MED_NIVEL = /\b0*(\d{2,4})\s*[xX]\s*0*(\d{2,4})(?:\s*[xX]\s*0*(\d{2,4}))?\b/;
function medidaEstandar_(nombre) {
  var m = _MED_NIVEL.exec(String(nombre || ''));
  if (!m) return '';
  return [m[1], m[2], m[3]].filter(Boolean).map(function (x) { return String(+x); }).join('X');
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
