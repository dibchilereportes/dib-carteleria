/**
 * Único punto del frontend que habla con el backend (Apps Script).
 * GET para lecturas; POST text/plain para "lote" (sin preflight CORS).
 * Expone window.api(action, params, opts) y window.cargarConfig().
 */
(function () {
  let CFG = null;
  const memo = new Map();

  async function cargarConfig() {
    if (CFG) return CFG;
    const r = await fetch("config/app.json", { cache: "no-store" });
    CFG = await r.json();
    if (!CFG.gasUrl) throw Object.assign(new Error("config/app.json sin gasUrl"), { code: "SIN_CONFIG" });
    return CFG;
  }

  async function api(action, params, opts) {
    params = params || {}; opts = opts || {};
    const metodo = opts.metodo || "GET", ttl = opts.ttl == null ? 60000 : opts.ttl;
    const cfg = await cargarConfig();
    const key = metodo + action + JSON.stringify(params);
    const hit = memo.get(key);
    if (ttl && hit && Date.now() - hit.t < ttl) return hit.v;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let resp;
    try {
      if (metodo === "GET") {
        const qs = new URLSearchParams(Object.assign({ action: action, t: cfg.token || "" }, limpiar(params)));
        resp = await fetch(cfg.gasUrl + "?" + qs, { signal: ctrl.signal, redirect: "follow" });
      } else {
        resp = await fetch(cfg.gasUrl, {
          method: "POST", signal: ctrl.signal, redirect: "follow",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(Object.assign({ action: action, t: cfg.token || "" }, params))
        });
      }
    } catch (e) {
      throw Object.assign(new Error("Sin conexión con el servidor."), { code: e.name === "AbortError" ? "TIMEOUT" : "RED" });
    } finally { clearTimeout(timer); }

    let j;
    try { j = await resp.json(); }
    catch (e) { throw Object.assign(new Error("Respuesta inválida del servidor."), { code: "RESPUESTA" }); }
    if (!j.ok) throw Object.assign(new Error((j.error && j.error.msg) || "Error"), { code: (j.error && j.error.code) || "ERROR" });
    if (ttl) memo.set(key, { t: Date.now(), v: j });
    return j;
  }

  function limpiar(p) {
    const out = {};
    Object.keys(p).forEach(k => { const v = p[k]; if (v !== undefined && v !== null && v !== "") out[k] = String(v); });
    return out;
  }

  window.api = api;
  window.cargarConfig = cargarConfig;
  window.apiInvalidar = () => memo.clear();
})();
