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
