/**
 * Bootstrap de la app. Versión mínima funcional: tienda/modo desde la URL,
 * buscador contra el backend, ficha con variantes y un cartel genérico imprimible.
 * Las 6 plantillas SVG del HTML original se portan a src/templates/ (ver docs/ARQUITECTURA).
 */
import { api, cargarConfig } from './api/client.js';

const $ = (s) => document.querySelector(s);
const clp = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-CL');

const ESTADO = { tienda: null, modo: 'general', cfg: null, tiendas: null, linea: '', sel: null };

async function init() {
  const url = new URL(location.href);
  const tiendasCfg = await (await fetch('config/tiendas.json', { cache: 'no-store' })).json();
  ESTADO.tiendas = tiendasCfg;

  ESTADO.tienda = url.searchParams.get('tienda') || localStorage.getItem('tienda') || Object.keys(tiendasCfg.tiendas)[0];
  ESTADO.modo = url.searchParams.get('modo') || 'general';
  if (!tiendasCfg.tiendas[ESTADO.tienda]) ESTADO.tienda = Object.keys(tiendasCfg.tiendas)[0];
  localStorage.setItem('tienda', ESTADO.tienda);

  const t = tiendasCfg.tiendas[ESTADO.tienda], m = tiendasCfg.modos[ESTADO.modo];
  document.documentElement.style.setProperty('--acento', m.acento || t.acento);
  $('#titulo').textContent = `Cartelería ${t.nombre} · ${m.titulo}`;

  // selector de tienda/modo
  const sel = $('#selTienda');
  for (const [k, v] of Object.entries(tiendasCfg.tiendas))
    for (const mo of v.modos) {
      const o = document.createElement('option');
      o.value = `${k}|${mo}`; o.textContent = `${v.nombre} · ${tiendasCfg.modos[mo].titulo}`;
      o.selected = k === ESTADO.tienda && mo === ESTADO.modo;
      sel.appendChild(o);
    }
  sel.onchange = () => { const [ti, mo] = sel.value.split('|'); location.search = `?tienda=${ti}&modo=${mo}`; };

  try {
    const cfg = await cargarConfig();
    const h = await api('health', {}, { ttl: 0 });
    $('#estado').textContent = `Backend v${h.version}${h.mock ? ' · DATOS SIMULADOS' : ''} · build ${cfg.build || '-'}`;
  } catch (e) { $('#estado').textContent = `Sin backend: ${e.message}`; }

  cargarChips();
  $('#q').addEventListener('input', debounce(buscar, 350));
  $('#q').focus();
}

async function cargarChips() {
  try {
    const tx = await api('taxonomia', { tienda: ESTADO.tienda, modo: ESTADO.modo }, { ttl: 6 * 3600_000 });
    const box = $('#chips'); box.innerHTML = '';
    tx.arbol.forEach((l) => {
      const b = document.createElement('button');
      b.className = 'chip'; b.textContent = l.nombre;
      b.onclick = () => { ESTADO.linea = ESTADO.linea === l.nombre ? '' : l.nombre; pintarChips(); buscar(); };
      box.appendChild(b);
    });
    pintarChips();
  } catch (e) { $('#chips').textContent = ''; }
}
function pintarChips() {
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.textContent === ESTADO.linea));
}

async function buscar() {
  const q = $('#q').value.trim();
  const res = $('#res');
  if (q.length < 2 && !ESTADO.linea) { res.innerHTML = '<p class="hint">Escribe al menos 2 letras o elige una línea.</p>'; return; }
  res.innerHTML = '<p class="hint">Buscando…</p>';
  try {
    const r = await api('buscar', { tienda: ESTADO.tienda, modo: ESTADO.modo, q, linea: ESTADO.linea, limit: 50 });
    if (!r.grupos.length) { res.innerHTML = '<p class="hint">Sin resultados.</p>'; return; }
    res.innerHTML = r.grupos.map((g) => `
      <button class="card" data-grupo="${escapar(g.nombre)}">
        <div class="card-nombre">${escapar(g.nombre)}</div>
        <div class="card-meta">${escapar(g.linea)} · ${escapar(g.familia)} · ${g.variantes} variante${g.variantes > 1 ? 's' : ''}${g.motivo ? ' · <b>' + escapar(g.motivo) + '</b>' : ''}</div>
        <div class="card-precio">${g.desde === g.hasta ? clp(g.desde) : clp(g.desde) + ' – ' + clp(g.hasta)}${g.en_oferta ? ' <span class="off">OFERTA</span>' : ''}</div>
      </button>`).join('');
    res.querySelectorAll('.card').forEach((c) => (c.onclick = () => abrirHoja(c.dataset.grupo)));
  } catch (e) { res.innerHTML = `<p class="err">${escapar(e.message)} <small>(${e.code})</small></p>`; }
}

async function abrirHoja(grupo) {
  const panel = $('#panel');
  panel.hidden = false; panel.innerHTML = '<p class="hint">Cargando ficha…</p>';
  try {
    const p = await api('producto', { tienda: ESTADO.tienda, modo: ESTADO.modo, grupo }, { ttl: 30_000 });
    ESTADO.sel = p;
    panel.innerHTML = `
      <div class="panel-head"><h2>${escapar(p.grupo)}</h2><button id="cerrar">✕</button></div>
      <div class="meta">${escapar(p.linea)} · ${escapar(p.familia)} · ${escapar(p.subfamilia)} · precios al ${fechaCL(p.fecha)}</div>
      <table><thead><tr><th>SKU</th><th>Variante</th><th>Normal</th><th>Dcto</th><th>Oferta</th><th>Stock</th><th></th></tr></thead>
      <tbody>${p.items.map((it, i) => `<tr>
        <td class="mono">${escapar(it.sku)}</td><td>${escapar(it.descripcion)}</td>
        <td>${clp(it.precio_normal)}</td><td>${it.dto ? it.dto + '%' : '–'}</td><td><b>${clp(it.precio_oferta)}</b></td>
        <td>${it.stock ?? '–'}${it.motivo ? '<br><small>' + escapar(it.motivo) + '</small>' : ''}</td>
        <td><button class="mini" data-i="${i}">Cartel</button></td></tr>`).join('')}</tbody></table>
      <div id="preview"></div>
      <div class="acciones"><button id="imprimir" disabled>Imprimir</button></div>`;
    $('#cerrar').onclick = () => { panel.hidden = true; panel.innerHTML = ''; };
    panel.querySelectorAll('.mini').forEach((b) => (b.onclick = () => previsualizar(p, p.items[+b.dataset.i])));
  } catch (e) { panel.innerHTML = `<p class="err">${escapar(e.message)}</p>`; }
}

/** Cartel genérico 130×180 mm (1 unidad SVG = 1 mm). Reemplazar por las plantillas reales. */
function cartelGenerico(p, it) {
  const w = 130, h = 180, ac = getComputedStyle(document.documentElement).getPropertyValue('--acento').trim();
  const oferta = it.dto > 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}mm" height="${h}mm" class="cartel">
    <rect width="${w}" height="${h}" fill="#fff" stroke="#999" stroke-width="0.3"/>
    <rect x="0" y="0" width="${w}" height="18" fill="${ac}"/>
    <text x="${w / 2}" y="12" text-anchor="middle" font-size="8" font-weight="700" fill="#fff" font-family="Arial">${escapar(p.grupo)}</text>
    <text x="${w / 2}" y="34" text-anchor="middle" font-size="7" fill="#333" font-family="Arial">${escapar(it.descripcion)}</text>
    ${oferta ? `<text x="${w / 2}" y="62" text-anchor="middle" font-size="9" fill="#666" font-family="Arial">Antes <tspan text-decoration="line-through">${clp(it.precio_normal)}</tspan></text>
    <rect x="${w - 34}" y="44" width="28" height="14" rx="2" fill="#c8102e"/>
    <text x="${w - 20}" y="54" text-anchor="middle" font-size="8" font-weight="700" fill="#fff" font-family="Arial">-${it.dto}%</text>` : ''}
    <text x="${w / 2}" y="105" text-anchor="middle" font-size="26" font-weight="800" fill="${ac}" font-family="Arial">${clp(it.precio_oferta)}</text>
    ${it.ppum_valor ? `<text x="${w / 2}" y="118" text-anchor="middle" font-size="5" fill="#333" font-family="Arial">${clp(it.ppum_valor)} por ${escapar(it.ppum_unidad)}</text>` : ''}
    <text x="${w / 2}" y="${h - 14}" text-anchor="middle" font-size="4" fill="#444" font-family="Arial">${escapar(p.legal)}</text>
    ${p.vig_hasta ? `<text x="${w / 2}" y="${h - 9}" text-anchor="middle" font-size="4" fill="#444" font-family="Arial">Vigencia: ${fechaCL(p.vig_desde)} al ${fechaCL(p.vig_hasta)}</text>` : ''}
    <text x="${w - 4}" y="${h - 3}" text-anchor="end" font-size="3.5" fill="#888" font-family="Arial">${escapar(it.sku)}</text>
  </svg>`;
}

function previsualizar(p, it) {
  const svg = cartelGenerico(p, it);
  $('#preview').innerHTML = svg;
  const btn = $('#imprimir'); btn.disabled = false;
  btn.onclick = () => { $('#printRoot').innerHTML = svg; window.print(); };
}

function fechaCL(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return iso;
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    (iso.length > 10 ? ' ' + d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }) : '');
}
function escapar(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

init();
