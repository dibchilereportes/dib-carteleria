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
