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
