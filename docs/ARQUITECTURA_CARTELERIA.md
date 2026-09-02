# Cartelería DIB — Arquitectura de la plataforma única

Versión 1.0 · 02-09-2026 · Reemplaza a `carteleria_dib_6.html`, `carteleria_dib_descartados_1.html`, `carteleria_sur_2.html`, `carteleria_sur_descartados.html`.

---

## 0. Diagnóstico de lo que existe hoy

Los cuatro HTML son **la misma plantilla** (mismo motor SVG en mm, mismas 6 plantillas, mismos ids de DOM) con un bloque `const DATOS = {...}` distinto inyectado por `actualizar_carteleria.py` desde Odoo. Lo que cambia entre archivos es solo esto:

| Archivo | `meta.codigo` | Lista de precios | Descartados | `marca.acento` | Niveles de navegación |
|---|---|---|---|---|---|
| carteleria_dib_6 | `GENERAL` | Tiendas DIB (CLP) | no | `#183C41` | línea → familia → subfamilia |
| carteleria_dib_descartados_1 | `DIB_OUT` (inferido) | Tiendas DIB (CLP) | sí | `#8A5A00` | motivo → línea → familia → subfamilia |
| carteleria_sur_2 | `SUR` (inferido) | Tiendas Sur | no | `#183C41` | línea → familia → subfamilia |
| carteleria_sur_descartados | `SUR_OUT` | Tiendas Sur | sí | `#8A5A00` | motivo → línea → familia → subfamilia |

Problemas estructurales que la nueva arquitectura elimina:

1. **Maestro completo en el navegador**: 2.666 a 7.442 productos embebidos como TSV (300–650 KB por archivo). Cualquiera que abra "ver código fuente" tiene toda la lista de precios y stock de la cadena.
2. **Datos congelados**: la fecha del catálogo es la de la última corrida del script Python (27-08-2026). Un cambio de precio en Odoo no se ve hasta regenerar y redistribuir 4 archivos.
3. **Combinatoria de archivos**: tiendas × listas × modos = N archivos. Con una tercera lista de precios o una tienda con condiciones propias, el número de HTML crece y cada corrección de plantilla hay que replicarla.
4. **Lógica de negocio duplicada**: `parsearNombre`, `clasificar`, `REGLAS_FORMATO`, redondeo, reglas PPUM viven en el HTML *y* en el ETL Python ("espeja el ETL del catálogo").

Lo que **sí se conserva** porque está bien resuelto: el motor de plantillas SVG con viewBox en mm (tamaño físico exacto), las 6 plantillas (`ALF_9X11`, `ALF_65X9`, `MUEBLES_8X5`, `TEX_LIM_NORMAL`, `TEX_LIM_PROMO`, `ROLLER_13X18`), la imposición en hoja con marcas de corte, la bandeja de impresión, los textos legales (art. 35 Ley 19.496 y PPUM Decreto 38/2024) y el flujo de UI (buscar → chips de jerarquía → tarjeta → hoja → imprimir/PDF).

---

## 1. Arquitectura objetivo

```
┌──────────────────────┐   HTTPS GET/POST    ┌──────────────────────────┐   HTTPS + API key   ┌──────────────┐
│  GitHub Pages        │ ──────────────────► │  Google Apps Script      │ ──────────────────► │  API ERP     │
│  (frontend estático) │ ◄────────────────── │  Web App (backend/proxy) │ ◄────────────────── │  (Odoo)      │
│  HTML + CSS + JS     │   JSON mínimo       │  · valida parámetros     │   respuesta cruda   │              │
│  · UI, plantillas    │   (solo lo pedido)  │  · guarda la API key     │                     │              │
│  · render SVG        │                     │  · filtra campos         │                     │              │
│  · impresión / PDF   │                     │  · cache corto           │                     │              │
└──────────────────────┘                     │  · log de uso            │                     └──────────────┘
                                             └──────────────────────────┘
                                                        │
                                                        ▼
                                             Google Sheet "config" (opcional):
                                             tiendas, listas de precio, reglas de formato,
                                             textos legales, vigencias — editable sin deploy
```

Principios de diseño:

- **El navegador nunca ve el maestro ni la key.** Solo recibe el resultado de una búsqueda acotada (máx. 50 coincidencias) o la ficha de un producto con sus variantes.
- **Backend sin estado y tonto a propósito.** Apps Script traduce "búscame X para la tienda Y" a la llamada del ERP, recorta la respuesta y la devuelve. No renderiza nada.
- **La configuración vive fuera del código.** Tiendas, listas de precios, acento de color, textos legales, reglas de formato: en un JSON versionado (`config/`) para lo que cambia con deploy, y en una Google Sheet para lo que cambia operaciones sin tocar el repo.
- **Las plantillas son módulos con contrato.** Agregar un formato = agregar un archivo en `src/templates/` y una línea en el registro. Nada más.

---

## 2. Flujo de información, paso a paso

### 2.1 Carga inicial (una vez por sesión)

1. El usuario abre `https://<usuario>.github.io/carteleria/?tienda=sur` (o elige tienda en pantalla; la elección queda en `localStorage`).
2. El frontend carga `config/tiendas.json` (estático, en el mismo repo): nombre, acento, lista de precios, plantillas habilitadas, texto legal por defecto.
3. El frontend llama `GET {GAS_URL}?action=taxonomia&tienda=sur`. El backend devuelve solo la jerarquía (líneas → familias → subfamilias, ~700 strings) para pintar los chips de navegación. Se cachea 12 h en `localStorage` con `etag`.

### 2.2 Búsqueda

4. El usuario escribe "plumon 2p" o navega chips. El frontend llama:
   `GET {GAS_URL}?action=buscar&tienda=sur&q=plumon%202p&linea=ROPA%20DE%20CAMA&modo=general&limit=50`
5. Apps Script valida, consulta el ERP con filtro (`name ilike`, `default_code ilike`, categoría, lista de precios, stock > 0 si `modo=general`), y responde:

```json
{
  "ok": true,
  "tienda": "sur",
  "lista": "Tiendas Sur",
  "fecha": "2026-09-02T11:40:00-04:00",
  "total": 12,
  "grupos": [
    { "nombre": "PLUMON TODA ESTACION", "linea": "ROPA DE CAMA", "familia": "PLUMONES",
      "variantes": 4, "desde": 29990, "hasta": 59990, "en_oferta": true }
  ]
}
```

   Nota: se responde **agrupado por nombre base** (misma lógica que hoy hace `indexar()`), pero el agrupado se calcula en el backend. El navegador solo ve resúmenes.

### 2.3 Ficha y variantes (lo que se imprime)

6. El usuario abre una tarjeta. El frontend pide:
   `GET {GAS_URL}?action=producto&tienda=sur&grupo=PLUMON%20TODA%20ESTACION&modo=general`
7. Respuesta: las variantes de ese grupo con exactamente los campos que consumen las plantillas:

```json
{
  "ok": true,
  "grupo": "PLUMON TODA ESTACION",
  "linea": "ROPA DE CAMA", "familia": "PLUMONES", "subfamilia": "PLUMON TODA ESTACION",
  "legal": "Precios incluyen IVA. Válido hasta agotar stock.",
  "vig_desde": "", "vig_hasta": "",
  "items": [
    { "sku": "R610012-0000/00", "descripcion": "1,5 PLAZAS", "precio_normal": 39990,
      "dto": 30, "precio_oferta": 27990, "outlet": false, "descontinuado": false,
      "stock": 14, "motivo": "", "ppum_valor": null, "ppum_unidad": "" }
  ]
}
```

8. El frontend calcula `formatosPara(item)` (reglas de formato), dibuja el SVG, arma la hoja, imprime o exporta PDF. Igual que hoy.

### 2.4 Bandeja multi-producto

9. La bandeja guarda solo `sku` + `grupo` de lo marcado. Al imprimir, hace una única llamada `POST {GAS_URL}` con `{action:"lote", tienda:"sur", skus:[...]}` (máx. 60) y recibe los items ya frescos. Así el precio impreso es el del momento de imprimir, no el del momento de marcar.

### 2.5 Lo que NUNCA viaja al navegador

- La API key del ERP.
- El maestro completo o listados sin filtro (`q` vacío y sin `linea` → error 400).
- Costos, márgenes, proveedor, stock de otras tiendas, campos internos de Odoo.
- Respuestas de más de `limit` (tope duro 100 en el backend, independiente del parámetro).

---

## 3. Estructura de carpetas del repositorio

```
carteleria/
├── index.html                  # única página; carga src/app.js como módulo ES
├── 404.html                    # redirige a index.html conservando ?tienda= (SPA en Pages)
├── config/
│   ├── tiendas.json            # catálogo de tiendas/listas (ver 3.1)
│   ├── formatos.json           # reglas nombre/categoría → plantillas permitidas
│   └── legal.json              # textos legales por defecto y variantes (PPUM, promo, outlet)
├── src/
│   ├── app.js                  # bootstrap: lee tienda, carga config, monta UI
│   ├── api/
│   │   └── client.js           # único punto que habla con Apps Script (fetch, timeout, reintento, cache)
│   ├── core/
│   │   ├── formato.js          # clp(), pct(), ppumTexto(), fechaCL(), redondear()
│   │   ├── reglas.js           # reglaDe(), formatosPara(), agrupa()  ← lee config/formatos.json
│   │   ├── texto.js            # fitSize(), anchoTexto(), partirEnDos()  (medición canvas)
│   │   └── legal.js            # pieLegal(), bloquePPUM() según Ley 19.496 / Decreto 38
│   ├── templates/
│   │   ├── registry.js         # registra plantillas: {id, tipo, w, h, aplica(ctx), render(ctx,cfg)}
│   │   ├── _primitivas.js      # T(), R(), L(), badgeOff(), codigoSKU(), envolver()
│   │   ├── alf_9x11.js
│   │   ├── alf_65x9.js
│   │   ├── muebles_8x5.js
│   │   ├── tex_lim_normal.js
│   │   ├── tex_lim_promo.js
│   │   └── roller_13x18.js
│   ├── print/
│   │   ├── papeles.js          # PAPELES (A4, carta, exacto), capacidadHoja()
│   │   ├── imposicion.js       # imponer(), marcasCorte()
│   │   └── salida.js           # imprimir(), exportar PDF (print CSS @page en mm)
│   ├── ui/
│   │   ├── estado.js           # store mínimo: tienda, modo, ruta chips, SEL, BANDEJA
│   │   ├── buscador.js         # input + chips + tarjetas (paginado 200 como hoy)
│   │   ├── hoja.js             # panel de producto: variantes, formato, papel, copias, preview
│   │   ├── bandeja.js          # impresión multi-producto
│   │   └── toast.js
│   └── styles/
│       ├── base.css
│       ├── ui.css
│       └── print.css           # @page, ocultar UI, printRoot
├── backend/                    # código de Apps Script (se sube con clasp; NO se sirve en Pages)
│   ├── appsscript.json
│   ├── Code.gs                 # doGet/doPost, router
│   ├── erp.gs                  # cliente del ERP (UrlFetchApp + API key desde PropertiesService)
│   ├── handlers.gs             # buscar, producto, lote, taxonomia, health
│   ├── validar.gs              # sanitización y validación de parámetros
│   ├── mapear.gs               # ERP → DTO mínimo (whitelist de campos)
│   ├── cache.gs                # CacheService con claves por tienda/consulta
│   └── log.gs                  # registro de uso en Sheet (opcional)
├── docs/
│   ├── ARQUITECTURA.md         # este documento
│   ├── NUEVA_PLANTILLA.md      # cómo agregar un formato
│   └── NUEVA_TIENDA.md         # cómo agregar una tienda
├── .github/workflows/
│   └── pages.yml               # despliegue automático a GitHub Pages en cada push a main
├── .gitignore                  # backend/.clasp.json, .env, node_modules
└── README.md
```

### 3.1 `config/tiendas.json` (ejemplo)

```json
{
  "version": 1,
  "tiendas": {
    "dib":  { "nombre": "Tienda DIB",  "acento": "#183C41", "lista_erp": "Tiendas DIB (CLP)",
              "plantillas": ["ALF_9X11","ALF_65X9","MUEBLES_8X5","TEX_LIM_NORMAL","TEX_LIM_PROMO","ROLLER_13X18"],
              "modos": ["general","descartados"], "redondeo": "peso" },
    "sur":  { "nombre": "Tienda Sur",  "acento": "#183C41", "lista_erp": "Tiendas Sur",
              "plantillas": ["ALF_9X11","ALF_65X9","MUEBLES_8X5","TEX_LIM_NORMAL","TEX_LIM_PROMO","ROLLER_13X18"],
              "modos": ["general","descartados"], "redondeo": "peso" }
  },
  "modos": {
    "general":     { "titulo": "Lista general", "acento": null,      "filtro_stock": true,  "niveles": ["categoria","familia","subfamilia"] },
    "descartados": { "titulo": "Descartados · fuera del catálogo", "acento": "#8A5A00", "filtro_stock": false, "niveles": ["motivo","categoria","familia","subfamilia"] }
  }
}
```

Con esto, los 4 HTML de hoy son **2 tiendas × 2 modos de un mismo `index.html`**. Una tienda nueva (por ejemplo "Concepción" con lista propia) es una entrada más en este archivo y una entrada espejo en la config del backend. Cero código.

---

## 4. Backend en Google Apps Script

### 4.1 Contrato de la API

| `action` | Método | Parámetros | Devuelve |
|---|---|---|---|
| `health` | GET | — | `{ok, version, hora}` |
| `taxonomia` | GET | `tienda`, `modo` | jerarquía (líneas/familias/subfamilias, motivos si `descartados`) |
| `buscar` | GET | `tienda`, `modo`, `q` (≥2 chars) y/o `linea`,`familia`,`subfamilia`,`motivo`, `limit` (≤100), `pagina` | grupos resumidos |
| `producto` | GET | `tienda`, `modo`, `grupo` **o** `sku` | variantes con campos de impresión |
| `lote` | POST | `tienda`, `skus[]` (≤60) | items frescos para la bandeja |

Todas las respuestas: `{ ok: true, ...datos }` o `{ ok: false, error: { code, msg } }` con HTTP 200 (Apps Script no permite cambiar el status code; el cliente mira `ok`).

Códigos de error: `BAD_PARAM`, `TIENDA_DESCONOCIDA`, `CONSULTA_VACIA`, `LIMITE`, `ERP_TIMEOUT`, `ERP_ERROR`, `NO_ENCONTRADO`, `RATE_LIMIT`, `ORIGEN_NO_PERMITIDO`.

### 4.2 `Code.gs` — router

```javascript
const VERSION = '1.0.0';

function doGet(e)  { return responder_(manejar_(e, 'GET')); }
function doPost(e) { return responder_(manejar_(e, 'POST')); }

function manejar_(e, metodo) {
  try {
    const p = metodo === 'POST' ? parsearBody_(e) : (e.parameter || {});
    const accion = String(p.action || '').toLowerCase();

    validarOrigen_(p);                 // token de app + origen (ver 5)
    rateLimit_(p);                     // por tienda + IP aproximada (ver 5)

    switch (accion) {
      case 'health':     return { ok: true, version: VERSION, hora: new Date().toISOString() };
      case 'taxonomia':  return hTaxonomia_(validarTienda_(p), validarModo_(p));
      case 'buscar':     return hBuscar_(validarBuscar_(p));
      case 'producto':   return hProducto_(validarProducto_(p));
      case 'lote':       if (metodo !== 'POST') throw err_('BAD_PARAM', 'lote requiere POST');
                         return hLote_(validarLote_(p));
      default:           throw err_('BAD_PARAM', 'action inválida');
    }
  } catch (ex) {
    const code = ex.code || 'INTERNO';
    registrarError_(code, ex.message, e && e.parameter);
    // Nunca devolver stack ni mensajes crudos del ERP al navegador
    return { ok: false, error: { code, msg: mensajePublico_(code) } };
  }
}

function responder_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function parsearBody_(e) {
  try { return Object.assign({}, e.parameter, JSON.parse(e.postData.contents || '{}')); }
  catch (_) { throw err_('BAD_PARAM', 'body inválido'); }
}

function err_(code, msg) { const x = new Error(msg); x.code = code; return x; }
```

### 4.3 `validar.gs` — parámetros

```javascript
const CONFIG_TIENDAS = {
  // espejo de config/tiendas.json; lo que el ERP necesita para cada tienda
  dib: { pricelist_id: 3, nombre: 'Tiendas DIB (CLP)' },
  sur: { pricelist_id: 7, nombre: 'Tiendas Sur' },
};
const MODOS = ['general', 'descartados'];
const LIMITE_MAX = 100, LIMITE_DEF = 50, LOTE_MAX = 60, Q_MIN = 2, Q_MAX = 60;

function limpiar_(s, max) {
  return String(s == null ? '' : s).normalize('NFKC').replace(/[<>"'`;\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function validarTienda_(p) {
  const t = limpiar_(p.tienda, 20).toLowerCase();
  if (!CONFIG_TIENDAS[t]) throw err_('TIENDA_DESCONOCIDA', t);
  return t;
}
function validarModo_(p) {
  const m = limpiar_(p.modo || 'general', 20).toLowerCase();
  if (MODOS.indexOf(m) < 0) throw err_('BAD_PARAM', 'modo');
  return m;
}
function validarBuscar_(p) {
  const out = {
    tienda: validarTienda_(p), modo: validarModo_(p),
    q: limpiar_(p.q, Q_MAX),
    linea: limpiar_(p.linea, 60), familia: limpiar_(p.familia, 60),
    subfamilia: limpiar_(p.subfamilia, 60), motivo: limpiar_(p.motivo, 60),
    limit: Math.min(LIMITE_MAX, Math.max(1, parseInt(p.limit, 10) || LIMITE_DEF)),
    pagina: Math.max(1, parseInt(p.pagina, 10) || 1),
  };
  // Regla clave: nunca un listado sin filtro
  if (out.q.length < Q_MIN && !out.linea && !out.motivo) throw err_('CONSULTA_VACIA', 'falta q o linea');
  return out;
}
function validarProducto_(p) {
  const out = { tienda: validarTienda_(p), modo: validarModo_(p),
                grupo: limpiar_(p.grupo, 120), sku: limpiar_(p.sku, 40) };
  if (!out.grupo && !out.sku) throw err_('BAD_PARAM', 'grupo o sku');
  return out;
}
function validarLote_(p) {
  const skus = Array.isArray(p.skus) ? p.skus.map(s => limpiar_(s, 40)).filter(Boolean) : [];
  if (!skus.length) throw err_('BAD_PARAM', 'skus vacío');
  if (skus.length > LOTE_MAX) throw err_('LIMITE', 'máx ' + LOTE_MAX);
  return { tienda: validarTienda_(p), skus: Array.from(new Set(skus)) };
}
```

### 4.4 `erp.gs` — cliente del ERP (la key nunca sale de aquí)

```javascript
function erpProps_() {
  const sp = PropertiesService.getScriptProperties();
  return { url: sp.getProperty('ERP_URL'), key: sp.getProperty('ERP_API_KEY'), db: sp.getProperty('ERP_DB') };
}

/** Llamada genérica con timeout, reintento y sin filtrar detalles al cliente */
function erpFetch_(path, payload) {
  const { url, key } = erpProps_();
  if (!url || !key) throw err_('INTERNO', 'ERP no configurado');
  const opts = {
    method: 'post', contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + key },   // o 'X-API-Key': key según el ERP
    payload: JSON.stringify(payload), muteHttpExceptions: true, followRedirects: false,
  };
  let ultimo;
  for (let i = 0; i < 2; i++) {                     // 1 reintento
    try {
      const r = UrlFetchApp.fetch(url + path, opts);
      const st = r.getResponseCode();
      if (st >= 200 && st < 300) return JSON.parse(r.getContentText());
      if (st === 401 || st === 403) throw err_('ERP_ERROR', 'auth');       // no reintentar
      ultimo = err_('ERP_ERROR', 'HTTP ' + st);
    } catch (ex) { ultimo = ex.code ? ex : err_('ERP_TIMEOUT', ex.message); }
    Utilities.sleep(300);
  }
  throw ultimo;
}

/** Búsqueda de productos: solo los campos que después se mapean */
function erpBuscarProductos_(f) {
  const t = CONFIG_TIENDAS[f.tienda];
  const dominio = [['sale_ok', '=', true]];
  if (f.q)      dominio.push('|', ['name', 'ilike', f.q], ['default_code', 'ilike', f.q]);
  if (f.linea)  dominio.push(['categ_id.parent_path_name', '=', f.linea]);   // ajustar al modelo real
  if (f.modo === 'general') dominio.push(['qty_available', '>', 0], ['active', '=', true]);
  return erpFetch_('/api/products/search', {
    domain: dominio,
    fields: ['default_code','name','categ_id','x_familia','x_subfamilia','list_price','qty_available','active','x_motivo_descarte','x_outlet'],
    pricelist_id: t.pricelist_id,
    limit: f.limit * 6,          // ~6 variantes por grupo; el agrupado recorta
    offset: (f.pagina - 1) * f.limit * 6,
    order: 'name asc',
  });
}
```

> Ajusta `path`, header de auth y nombres de campos a la API del ERP que ya usas en los otros proyectos de Apps Script. Lo importante es que **este es el único archivo que conoce el ERP**; el resto del backend trabaja con el DTO de `mapear.gs`.

### 4.5 `mapear.gs` — whitelist de campos (filtrado)

```javascript
/** ERP → DTO de impresión. Todo lo que no está aquí NO sale del servidor. */
function aProducto_(r, cfg) {
  const lista = Number(r.list_price) || 0;
  const dto   = Number(r.discount_pct) || 0;
  return {
    sku: r.default_code,
    nombre: r.name,
    descripcion: r.variant_desc || '',
    categoria: r.categ_name, familia: r.x_familia || 'SIN FAMILIA', subfamilia: r.x_subfamilia || 'SIN SUBFAMILIA',
    precio_normal: lista,
    dto: dto,
    precio_oferta: redondear_(lista * (1 - dto / 100), cfg.redondeo || 'peso'),
    outlet: !!r.x_outlet, descontinuado: !r.active,
    stock: r.qty_available == null ? null : Number(r.qty_available),
    motivo: r.x_motivo_descarte || '',
    ppum_valor: r.x_ppum_valor || null, ppum_unidad: r.x_ppum_unidad || '',
  };
}

/** Agrupa por nombre base (misma regla que parsearNombre() del HTML actual) */
function agruparPorNombre_(items) {
  const g = new Map();
  items.forEach(p => {
    const k = nombreBase_(p.nombre);
    if (!g.has(k)) g.set(k, { nombre: k, linea: p.categoria, familia: p.familia, variantes: 0, desde: Infinity, hasta: 0, en_oferta: false });
    const x = g.get(k); x.variantes++; x.desde = Math.min(x.desde, p.precio_oferta);
    x.hasta = Math.max(x.hasta, p.precio_oferta); x.en_oferta = x.en_oferta || p.dto > 0;
  });
  return Array.from(g.values());
}
```

`nombreBase_` y `redondear_` se portan tal cual desde el HTML (`parsearNombre`, `redondear`). Así la regla vive **una sola vez**, en el backend; el frontend recibe `grupo` ya calculado.

### 4.6 `handlers.gs`

```javascript
function hBuscar_(f) {
  const key = 'b:' + JSON.stringify(f);
  return conCache_(key, 120, () => {                 // 2 min: precios frescos, ERP tranquilo
    const raw = erpBuscarProductos_(f);
    const items = (raw.records || []).map(r => aProducto_(r, CONFIG_TIENDAS[f.tienda]));
    const filtrados = f.modo === 'descartados' ? items.filter(p => p.descontinuado || p.stock === 0 || p.motivo)
                                              : items.filter(p => !p.descontinuado && p.stock > 0);
    const grupos = agruparPorNombre_(filtrados).slice(0, f.limit);
    return { ok: true, tienda: f.tienda, lista: CONFIG_TIENDAS[f.tienda].nombre,
             fecha: new Date().toISOString(), total: grupos.length, grupos };
  });
}

function hProducto_(f) {
  const raw = f.sku ? erpProductoPorSku_(f) : erpProductosPorGrupo_(f);
  const items = (raw.records || []).map(r => aProducto_(r, CONFIG_TIENDAS[f.tienda]));
  if (!items.length) throw err_('NO_ENCONTRADO', f.grupo || f.sku);
  const legal = legalPara_(f.tienda, items);          // texto legal + vigencia desde Sheet config
  return { ok: true, grupo: f.grupo || nombreBase_(items[0].nombre),
           linea: items[0].categoria, familia: items[0].familia, subfamilia: items[0].subfamilia,
           legal: legal.texto, vig_desde: legal.desde, vig_hasta: legal.hasta, items };
}

function hLote_(f) {
  const raw = erpProductosPorSkus_(f.tienda, f.skus);
  const items = (raw.records || []).map(r => aProducto_(r, CONFIG_TIENDAS[f.tienda]));
  const faltantes = f.skus.filter(s => !items.some(p => p.sku === s));
  return { ok: true, items, faltantes };
}

function hTaxonomia_(tienda, modo) {
  return conCache_('tax:' + tienda + ':' + modo, 21600, () => {   // 6 h
    const raw = erpFetch_('/api/categories/tree', { pricelist_id: CONFIG_TIENDAS[tienda].pricelist_id });
    return { ok: true, niveles: modo === 'descartados' ? ['motivo','categoria','familia','subfamilia'] : ['categoria','familia','subfamilia'],
             arbol: raw.tree, motivos: modo === 'descartados' ? MOTIVOS_DESCARTE : [] };
  });
}
```

### 4.7 `cache.gs`

```javascript
function conCache_(clave, seg, fn) {
  const c = CacheService.getScriptCache();
  const k = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, clave));
  const hit = c.get(k);
  if (hit) return JSON.parse(hit);
  const val = fn();
  try { c.put(k, JSON.stringify(val), seg); } catch (_) { /* >100 KB no se cachea */ }
  return val;
}
```

### 4.8 Despliegue del backend

1. Crear proyecto en script.google.com (o `clasp create --type webapp` desde `backend/`).
2. `Configuración del proyecto → Propiedades del script`: `ERP_URL`, `ERP_API_KEY`, `ERP_DB`, `APP_TOKEN`, `ORIGENES_PERMITIDOS` (`https://<usuario>.github.io`).
3. `Implementar → Nueva implementación → Aplicación web`: ejecutar como **yo**, acceso **cualquier persona** (anónimo). La URL `https://script.google.com/macros/s/AKfycb.../exec` es `GAS_URL` en el frontend.
4. Cada cambio: `clasp push && clasp deploy -i <deploymentId>` para conservar la misma URL.
5. `appsscript.json`: `"webapp": {"executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS"}`, `"runtimeVersion": "V8"`.

---

## 5. Seguridad

| Riesgo | Medida |
|---|---|
| Exposición de la API key | Solo en `PropertiesService` del script. Nunca en código, nunca en el repo, nunca en logs. Rotar cada 6 meses o al salir alguien con acceso al proyecto GAS. |
| Scraping del maestro vía el proxy | `CONSULTA_VACIA` si no hay `q` ni `linea`; `LIMITE_MAX=100`; `limit*6` de cabecera al ERP; nunca `offset` libre sin filtro. |
| Uso de la Web App desde otros sitios | La Web App anónima es pública por definición. Mitigar con (a) `APP_TOKEN` en el header/parámetro, incluido en el build del frontend — **no es secreto**, es fricción; (b) validar `Origin`/`Referer` cuando existan; (c) rate limit por token+`tienda` con `CacheService` (p. ej. 60 req/min). |
| Rate limit | `rateLimit_()`: contador en `CacheService` con clave `rl:<tienda>:<minuto>`; al superar el umbral devuelve `RATE_LIMIT`. Las cuotas de Apps Script (20.000 URLFetch/día) alcanzan para ~30 tiendas con uso normal; la caché de 2 min reduce a la mitad. |
| Inyección hacia el ERP | `limpiar_()` recorta y elimina comillas/`;`/`<>`; los filtros se arman como arrays de dominio, nunca concatenando strings en SQL/XML. |
| Fuga de detalle interno en errores | `mensajePublico_(code)` mapea a mensajes genéricos; el detalle va al log del script. |
| Datos sensibles en respuesta | Whitelist en `aProducto_`. Sin costo, margen, proveedor, stock por bodega. |
| Repo público de GitHub Pages | Pages gratis exige repo público (o plan Pro/Team para privado). Por eso `backend/` no lleva `.clasp.json` ni credenciales, y `GAS_URL` es lo único "expuesto", que ya está protegido por lo anterior. |
| Cambios de precio no autorizados | El frontend no escribe nunca. Backend solo `GET`/lectura sobre el ERP; la cuenta de API del ERP con permisos **solo lectura** sobre productos y listas de precios. |
| Auditoría | `log.gs` escribe `fecha, tienda, action, q, n_resultados, ms` en una Sheet (sin datos de precio). Sirve para ver qué se imprime y detectar abuso. |

`APP_TOKEN` se pasa como parámetro `t=` (Apps Script no expone headers custom en `doGet`). En `validarOrigen_` se compara contra `PropertiesService`; si algún día se filtra, se rota en propiedades y en `config/app.json` y se hace push.

---

## 6. Frontend: contratos que hacen escalable el sistema

### 6.1 Plantilla como módulo (`src/templates/*.js`)

```javascript
// src/templates/roller_13x18.js
export default {
  id: 'ROLLER_13X18',
  nombre: 'Roller 13×18',
  tipo: 'individual',            // 'individual' | 'listado'
  w: 130, h: 180,                // mm
  aplica: (ctx) => /\broller\b/i.test(ctx.item?.nombre || ''),
  copias: { EXACTO: 1, A4: 2 },
  render(ctx, cfg, P) {          // P = primitivas (T, R, L, badgeOff, pieLegal, bloquePPUM...)
    const s = [];
    s.push(P.R(0, 0, this.w, this.h, '#fff'));
    /* ...idéntico al cuerpo actual de TPLS.ROLLER_13X18... */
    return P.envolver(this.w, this.h, s.join(''), cfg);
  },
};
```

```javascript
// src/templates/registry.js
import alf9x11 from './alf_9x11.js';  /* ... */ import roller from './roller_13x18.js';
export const TEMPLATES = new Map([alf9x11, alf65x9, muebles8x5, texNormal, texPromo, roller].map(t => [t.id, t]));
export function formatosPara(item, tiendaCfg) {
  return [...TEMPLATES.values()]
    .filter(t => tiendaCfg.plantillas.includes(t.id))
    .filter(t => reglaDe(item) ? reglaDe(item).deja.includes(t.id) : true);
}
```

**Agregar un formato nuevo** (ej. "GÓNDOLA_4X3" para menaje): crear `gondola_4x3.js`, importarlo en `registry.js`, agregar el id a las tiendas que lo usan en `tiendas.json` y, si aplica, una regla en `formatos.json`. No se toca UI, impresión ni backend.

### 6.2 Reglas de formato en datos (`config/formatos.json`)

```json
[
  { "que": "Cortinas roller", "nombre": "\\broller\\b",  "deja": ["ROLLER_13X18"] },
  { "que": "Cojines",         "nombre": "\\bcojin",      "deja": ["TEX_LIM_NORMAL"] },
  { "que": "Plumones",        "nombre": "\\bplumon",     "deja": ["TEX_LIM_PROMO"] },
  { "que": "Sábanas",         "nombre": "\\bsabana",     "deja": ["TEX_LIM_NORMAL","TEX_LIM_PROMO"] },
  { "que": "Sofás",           "categoria": "SOFAS",      "agrupar": false }
]
```

### 6.3 Cliente API (`src/api/client.js`)

```javascript
const GAS_URL = window.APP_CONFIG.gasUrl, TOKEN = window.APP_CONFIG.token;
const memo = new Map();

export async function api(action, params = {}, { metodo = 'GET', ttl = 60_000 } = {}) {
  const key = action + JSON.stringify(params);
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;

  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 15_000);
  const qs = new URLSearchParams({ action, t: TOKEN, ...(metodo === 'GET' ? params : {}) });
  const r = await fetch(`${GAS_URL}?${qs}`, {
    method: metodo, signal: ctrl.signal, redirect: 'follow',
    // Apps Script exige text/plain para POST sin preflight CORS
    ...(metodo === 'POST' ? { headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, t: TOKEN, ...params }) } : {}),
  }).finally(() => clearTimeout(to));
  const j = await r.json();
  if (!j.ok) throw Object.assign(new Error(j.error.msg), { code: j.error.code });
  memo.set(key, { t: Date.now(), v: j });
  return j;
}
```

Detalle importante: Apps Script responde con redirect 302 a `script.googleusercontent.com`; `fetch` lo sigue solo si no hay headers custom → por eso el token va en la query y el POST es `text/plain`.

### 6.4 Modo sin conexión / ERP caído

`client.js` guarda en `localStorage` la última respuesta de `producto` por `tienda+grupo` (máx. 200 fichas, LRU). Si `ERP_TIMEOUT`, la UI muestra el cartel con banner "precios al DD-MM-AAAA HH:MM — verificar antes de imprimir" y no permite exportar PDF sin confirmación. La tienda no se queda sin carteles por una caída del ERP, pero tampoco imprime silenciosamente un precio viejo.

---

## 7. Crear el repositorio y publicar en GitHub Pages

### 7.1 Repositorio

```bash
mkdir carteleria && cd carteleria
git init -b main
# copiar la estructura de la sección 3 (o partir del scaffold)
cat > .gitignore <<'EOF'
backend/.clasp.json
backend/.clasprc.json
.env
node_modules/
*.log
EOF
git add . && git commit -m "Scaffold cartelería única"
gh repo create dib-carteleria --public --source=. --push     # o crear en github.com y git remote add
```

Repo **público** (requisito de Pages gratis). Nada sensible dentro: revisa con `git grep -i "AKfy\|api_key\|apikey"` antes del primer push.

### 7.2 Activar Pages (dos opciones)

**Opción A – desde rama (más simple):** Settings → Pages → Source: *Deploy from a branch* → Branch `main`, folder `/ (root)` → Save. En 1–2 min queda en `https://<usuario>.github.io/dib-carteleria/`.

**Opción B – GitHub Actions (recomendada, permite build):** Settings → Pages → Source: *GitHub Actions*, y crear `.github/workflows/pages.yml`:

```yaml
name: Deploy Pages
on: { push: { branches: [main] }, workflow_dispatch: {} }
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: true }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - name: Inyectar config pública
        run: |
          cat > config/app.json <<EOF
          { "gasUrl": "${{ vars.GAS_URL }}", "token": "${{ vars.APP_TOKEN }}", "build": "${GITHUB_SHA::7}" }
          EOF
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with: { path: '.' }
      - id: deployment
        uses: actions/deploy-pages@v4
```

`GAS_URL` y `APP_TOKEN` se cargan en Settings → Secrets and variables → Actions → **Variables** (no son secretos, pero así no quedan hardcodeados y se cambian sin commit). La carpeta `backend/` también se publica en Pages (son archivos `.gs` de texto, sin credenciales), lo cual es inofensivo; si prefieres que ni siquiera se vea, agrega un paso `rm -rf backend docs` antes de `upload-pages-artifact`, o lleva el backend a un repo privado aparte.

### 7.3 URL pública y acceso de tiendas

- URL base: `https://<usuario>.github.io/dib-carteleria/`
- Por tienda: `.../?tienda=sur` y `.../?tienda=sur&modo=descartados`. Se recomienda un QR/acceso directo en cada local con su URL.
- Dominio propio (opcional): `carteles.dib.cl` → Settings → Pages → Custom domain + CNAME en el DNS apuntando a `<usuario>.github.io`. HTTPS automático.
- `404.html` copia de `index.html` para que rutas tipo `/sur/descartados` también funcionen si más adelante se usa routing por path.

### 7.4 Checklist de puesta en marcha

1. Backend desplegado y `GET {GAS_URL}?action=health&t=TOKEN` devuelve `{ok:true}`.
2. `action=buscar&tienda=dib&q=roller` devuelve grupos en < 3 s.
3. `action=buscar&tienda=dib` (sin `q`) devuelve `CONSULTA_VACIA`.
4. Pages publicado; abrir `?tienda=sur`, buscar, abrir ficha, imprimir hoja A4 y medir con regla que el cartel 13×18 mide 13×18.
5. Comparar 20 SKUs al azar: precio del cartel nuevo = precio del HTML viejo del mismo día.
6. Apagar los 4 HTML (o dejarlos con banner "obsoleto, usa la nueva URL") después de una semana en paralelo.

---

## 8. Plan de migración (sin big bang)

| Fase | Qué | Resultado |
|---|---|---|
| 1 (1–2 días) | Backend GAS con `health`, `buscar`, `producto` contra el ERP. Probar con curl/Postman. | API funcionando, sin frontend |
| 2 (2–3 días) | Extraer el JS del HTML actual a `src/` sin cambiar comportamiento: primero `core/`, `templates/`, `print/`; luego `ui/`. Reemplazar `DATOS.tsv` por llamadas a `client.js`. | `index.html` único que reemplaza a los 4 |
| 3 (1 día) | `config/tiendas.json` + `formatos.json`; parametrizar acento, título, niveles. | 2 tiendas × 2 modos desde config |
| 4 (1 día) | Pages + workflow + QR por tienda. Semana en paralelo con los HTML viejos. | URL pública |
| 5 | Retirar `actualizar_carteleria.py` (o dejarlo solo como respaldo offline que genera un `catalogo_offline.json` para emergencias). | Un solo origen de verdad: el ERP |

---

## 9. Escalabilidad: qué crece sin reescribir

| Necesidad futura | Qué se toca |
|---|---|
| Nueva tienda / ciudad | 1 entrada en `config/tiendas.json` + 1 en `CONFIG_TIENDAS` del backend |
| Nueva lista de precios | Igual que arriba (`lista_erp` / `pricelist_id`) |
| Nuevo formato de cartel | 1 archivo en `src/templates/` + registro + id en tiendas que lo usan |
| Nuevo modo (ej. "liquidación", "outlet") | 1 entrada en `modos` de `tiendas.json` + 1 filtro en `hBuscar_` |
| Cambio de texto legal o vigencia de promo | Sheet de configuración (sin deploy) o `config/legal.json` |
| Cambio de ERP | Solo `erp.gs` y `mapear.gs`; el contrato JSON hacia el frontend no cambia |
| Multi-idioma / multi-moneda | `core/formato.js` recibe `locale`/`moneda` desde la config de tienda |
| Carteles con imagen del producto | `producto` devuelve `imagen_url` (proxy o Drive); la plantilla decide si la usa |
| Volumen alto (>20k req/día) | Migrar el mismo `handlers.gs` a Cloud Run / Cloudflare Workers; el frontend solo cambia `gasUrl` |

---

## Supuestos

- El ERP es Odoo (según el origen `"Odoo · Tiendas DIB (CLP)"` de los datos actuales) y su API expone búsqueda de productos con filtro por lista de precios; los nombres de endpoint/campos en `erp.gs` son ilustrativos y deben ajustarse a la API real que ya consumes en los otros proyectos GAS.
- El parser de nombres y el redondeo actuales del HTML se portan sin cambios al backend.
