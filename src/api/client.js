/**
 * Único punto del frontend que habla con el backend (Apps Script).
 * - GET para lecturas, POST text/plain para "lote" (evita preflight CORS).
 * - Timeout 15 s, caché en memoria por TTL, errores normalizados {code, message}.
 */
let CFG = null;
const memo = new Map();

export async function cargarConfig() {
  if (CFG) return CFG;
  const r = await fetch(new URL('../../config/app.json', import.meta.url), { cache: 'no-store' });
  CFG = await r.json();
  if (!CFG.gasUrl) throw Object.assign(new Error('config/app.json sin gasUrl'), { code: 'SIN_CONFIG' });
  return CFG;
}

export async function api(action, params = {}, { metodo = 'GET', ttl = 60_000 } = {}) {
  const cfg = await cargarConfig();
  const key = metodo + action + JSON.stringify(params);
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let resp;
  try {
    if (metodo === 'GET') {
      const qs = new URLSearchParams({ action, t: cfg.token || '', ...limpiarParams(params) });
      resp = await fetch(`${cfg.gasUrl}?${qs}`, { signal: ctrl.signal, redirect: 'follow' });
    } else {
      resp = await fetch(cfg.gasUrl, {
        method: 'POST', signal: ctrl.signal, redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, t: cfg.token || '', ...params }),
      });
    }
  } catch (e) {
    throw Object.assign(new Error('Sin conexión con el servidor.'), { code: e.name === 'AbortError' ? 'TIMEOUT' : 'RED' });
  } finally { clearTimeout(timer); }

  let j;
  try { j = await resp.json(); }
  catch { throw Object.assign(new Error('Respuesta inválida del servidor.'), { code: 'RESPUESTA' }); }
  if (!j.ok) throw Object.assign(new Error(j.error?.msg || 'Error'), { code: j.error?.code || 'ERROR' });
  memo.set(key, { t: Date.now(), v: j });
  return j;
}

function limpiarParams(p) {
  const out = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') out[k] = String(v);
  return out;
}

export function invalidar() { memo.clear(); }
