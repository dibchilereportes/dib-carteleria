/* Motor original de cartelería DIB, conectado al backend (Apps Script) en vez del catálogo embebido. */

/* ================================================================
   NÚCLEO — utilidades, formato CLP, importadores, validador
   ================================================================ */
"use strict";

/* Copia intacta del archivo, para poder regenerarlo con los precios editados */
const ORIGINAL_HTML = "";

const MM = 3.7795275591; /* 1 mm en px CSS @96dpi */
const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/* ---------- Formato de moneda chilena: $12.990, sin decimales ---------- */
function clp(n, opts) {
  opts = opts || {};
  if (n == null || n === "" || isNaN(n)) return opts.vacio != null ? opts.vacio : "—";
  const v = Math.round(Number(n));
  const s = Math.abs(v).toLocaleString("es-CL", { maximumFractionDigits: 0 });
  return (v < 0 ? "-" : "") + "$" + s;
}
/* Precio por unidad de medida (Decreto 38/2024): "$X por <unidad>" */
function ppumTexto(p) {
  if (!p.ppum_valor || !p.ppum_unidad) return "";
  return clp(p.ppum_valor) + " por " + p.ppum_unidad;
}
function pct(a, b) { /* descuento % de b respecto de a */
  if (!a || !b || a <= 0) return null;
  return Math.round((1 - b / a) * 100);
}
function hoyISO() { const d = new Date(); return d.toISOString().slice(0, 10); }
function fechaCL(iso) {
  if (!iso) return "";
  const p = String(iso).slice(0, 10).split("-");
  return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : String(iso);
}
function slug(s){ return String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-zA-Z0-9]+/g,"_").replace(/^_|_$/g,"").toUpperCase(); }
function norm(s){ return String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase(); }

/* ================================================================
   IMPORTADOR CSV  (detecta ; o , o tab, respeta comillas)
   ================================================================ */
function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const head = text.split(/\r?\n/)[0] || "";
  const cand = [";", ",", "\t", "|"];
  let sep = ";", best = -1;
  cand.forEach(c => { const n = head.split(c).length; if (n > best) { best = n; sep = c; } });

  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch === "\r") { /* skip */ }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ""));
}

/* ================================================================
   IMPORTADOR XLSX NATIVO — sin librerías externas.
   Un .xlsx es un ZIP; usamos DecompressionStream('deflate-raw')
   (Chrome/Edge/Safari modernos) para descomprimir sin dependencias.
   ================================================================ */
async function unzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  /* localizar End Of Central Directory */
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i > u8.length - 66000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Archivo .xlsx no válido (no es un ZIP).");
  const nEnt = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = {};
  const dec = new TextDecoder();

  for (let e = 0; e < nEnt; e++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize  = dv.getUint32(off + 20, true);
    const nlen   = dv.getUint16(off + 28, true);
    const elen   = dv.getUint16(off + 30, true);
    const clen   = dv.getUint16(off + 32, true);
    const lho    = dv.getUint32(off + 42, true);
    const name   = dec.decode(u8.subarray(off + 46, off + 46 + nlen));
    /* cabecera local para saber dónde empieza la data */
    const lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true);
    const dstart = lho + 30 + lnlen + lelen;
    files[name] = { method, data: u8.subarray(dstart, dstart + csize) };
    off += 46 + nlen + elen + clen;
  }

  async function read(name) {
    const f = files[name];
    if (!f) return null;
    if (f.method === 0) return dec.decode(f.data);
    if (typeof DecompressionStream === "undefined")
      throw new Error("Tu navegador no soporta descompresión nativa. Usa Chrome/Edge actualizado o importa un CSV.");
    const ds = new DecompressionStream("deflate-raw");
    const blob = new Blob([f.data.slice()]);
    const out = blob.stream().pipeThrough(ds);
    return await new Response(out).text();
  }
  return { names: Object.keys(files), read };
}

/* letra de columna -> índice 0-based */
function colIdx(ref) {
  let n = 0;
  for (const ch of ref) { const c = ch.charCodeAt(0); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); }
  return n - 1;
}

async function parseXLSX(buf) {
  const z = await unzip(buf);

  /* sharedStrings */
  const shared = [];
  const ss = await z.read("xl/sharedStrings.xml");
  if (ss) {
    const doc = new DOMParser().parseFromString(ss, "application/xml");
    Array.from(doc.getElementsByTagName("si")).forEach(si => {
      let s = "";
      Array.from(si.getElementsByTagName("t")).forEach(t => {
        /* ignorar los <t> dentro de rPh (fonética japonesa) */
        if (!t.parentNode || t.parentNode.nodeName !== "rPh") s += t.textContent;
      });
      shared.push(s);
    });
  }

  /* primera hoja */
  const wbXml = await z.read("xl/workbook.xml");
  let sheetPath = "xl/worksheets/sheet1.xml";
  const relXml = await z.read("xl/_rels/workbook.xml.rels");
  if (wbXml && relXml) {
    try {
      const wb = new DOMParser().parseFromString(wbXml, "application/xml");
      const sh = wb.getElementsByTagName("sheet")[0];
      const rid = sh.getAttribute("r:id") || sh.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      const rels = new DOMParser().parseFromString(relXml, "application/xml");
      Array.from(rels.getElementsByTagName("Relationship")).forEach(r => {
        if (r.getAttribute("Id") === rid) {
          let t = r.getAttribute("Target").replace(/^\//, "");
          sheetPath = t.startsWith("xl/") ? t : "xl/" + t;
        }
      });
    } catch (e) { /* fallback sheet1 */ }
  }
  const shXml = await z.read(sheetPath);
  if (!shXml) throw new Error("No se encontró la primera hoja del archivo.");

  const doc = new DOMParser().parseFromString(shXml, "application/xml");
  const rows = [];
  Array.from(doc.getElementsByTagName("row")).forEach(r => {
    const arr = [];
    Array.from(r.getElementsByTagName("c")).forEach(c => {
      const ref = c.getAttribute("r") || "";
      const i = Math.max(0, colIdx(ref.replace(/[0-9]/g, "")));
      const t = c.getAttribute("t");
      let v = "";
      if (t === "inlineStr") {
        const is = c.getElementsByTagName("t"); v = is.length ? is[0].textContent : "";
      } else {
        const vn = c.getElementsByTagName("v")[0];
        v = vn ? vn.textContent : "";
        if (t === "s") v = shared[parseInt(v, 10)] || "";
      }
      arr[i] = v;
    });
    for (let i = 0; i < arr.length; i++) if (arr[i] === undefined) arr[i] = "";
    rows.push(arr);
  });
  return rows.filter(r => r.some(c => String(c).trim() !== ""));
}

/* ================================================================
   MAPEO DE COLUMNAS — tolera nombres en distintas variantes
   ================================================================ */
const CAMPOS = {
  sku:            ["sku", "codigo", "código", "cod", "id", "codigo producto", "item",
                   "reglas de lista de precios/producto/referencia interna", "referencia interna"],
  nombre:         ["nombre", "producto", "descripcion producto", "nombre producto", "articulo", "artículo",
                   "reglas de lista de precios/producto/nombre"],
  grupo:          ["grupo", "familia", "linea", "línea", "titulo", "título", "encabezado", "cabecera"],
  descripcion:    ["descripcion", "descripción", "medida", "variante", "detalle", "descripcion / medida", "medidas", "formato"],
  marca:          ["marca", "brand"],
  categoria:      ["categoria", "categoría", "seccion", "sección", "rubro"],
  subcategoria:   ["subcategoria", "subcategoría"],
  precio_normal:  ["precio normal", "precio_normal", "pvp normal", "precio lista", "precio anterior", "precio antes", "normal", "precio_anterior",
                   "reglas de lista de precios/precio fijo", "precio fijo"],
  precio_oferta:  ["precio oferta", "precio_oferta", "pvp promo", "precio promo", "precio final", "precio actual", "precio", "oferta", "precio_actual"],
  descuento:      ["descuento", "dcto", "% descuento", "porcentaje descuento", "descuento_pct", "% off", "off",
                   "reglas de lista de precios/descuentos por linea", "descuentos por linea"],
  unidad:         ["unidad", "unidad medida", "um", "unidad de medida"],
  ppum_valor:     ["ppum", "ppum_valor", "precio unidad medida", "ppum valor", "precio por unidad"],
  ppum_unidad:    ["ppum_unidad", "ppum unidad", "unidad ppum", "por unidad"],
  vig_desde:      ["vigencia desde", "desde", "inicio", "vigencia_desde", "fecha inicio"],
  vig_hasta:      ["vigencia hasta", "hasta", "termino", "término", "vigencia_hasta", "fecha termino", "fecha término"],
  promo_texto:    ["promocion", "promoción", "promo", "mecanica", "mecánica", "texto promo"],
  estado:         ["estado", "activo", "status"],
  tienda:         ["tienda", "local", "sucursal"],
  legal:          ["legal", "nota legal", "texto legal", "condiciones"]
};


/* ================================================================
   PARSER DE NOMBRES DE PRODUCTO
   Separa "PLUMON TODA ESTACIÓN 2P" -> familia + variante, para que
   las plantillas de listado agrupen solas. Espeja el ETL del catálogo.
   ================================================================ */
const _MED   = /\b0*(\d{2,4})\s*[xX]\s*0*(\d{2,4})(?:\s*[xX]\s*0*(\d{2,4}))?/;
const _SEL2  = /\b2\s*(?:DA|ª|A|°)\.?\s*SEL(?:ECCION|ECCIÓN)?\.?/i;
const _TALLAS = [
  [/\bSUPER\s*KINGP?\b|\bS\.?\s*KINGP?\b|\bSKINGP?\b/i, "SUPER KING"],
  [/\bKING\s*P\b|\bKING\b/i,                            "KING"],
  [/\b2\s*1\/2\s*P(?:LAZAS?)?\b/i,                      "2½ PLAZAS"],
  [/\b1[.,]5\s*P(?:LAZAS?)?\b|\b1\s*1\/2\s*P\b/i,       "1.5 PLAZA"],
  [/\b2\s*P(?:LAZAS?)?\b/i,                             "2 PLAZAS"],
  [/\b1\s*P(?:LAZA)?\b/i,                               "1 PLAZA"],
  [/\bSECCIONAL\b/i,                                    "SECCIONAL"],
  [/\b3\s*C(?:UERPOS?)?\b/i,                            "3 CUERPOS"],
  [/\b2\s*C(?:UERPOS?)?\b/i,                            "2 CUERPOS"],
  [/\b1\s*C(?:UERPO)?\b/i,                              "1 CUERPO"]
];
const _COLORES = new Set(("BLANCO BLANCA NEGRO NEGRA GRIS BEIGE CRUDO CRUDA NATURAL AZUL ROJO ROJA VERDE AMARILLO " +
"ROSA ROSADO MORADO MARFIL CAFE CHOCOLATE CAMEL TAUPE TERRACOTA TERRA OCRE MOSTAZA CELESTE TURQUESA PLATA ORO " +
"DORADO COBRE BURDEO GUINDA VINO PETROLEO ARENA PIEDRA HUESO PERLA GRAFITO ANTRACITA CENIZA NOGAL CAPUCCINO " +
"CAPUCHINO MIEL TABACO OLIVA MENTA CORAL SALMON LILA FUCSIA MULTI MULTICOLOR BICOLOR CLARO CLARA OSCURO OSCURA " +
"MARENGO ACERO CARBON TOPO NUDE VISON PLOMO CALIPSO CIRUELA DAMASCO LADRILLO WHITE BLACK GREY GRAY IVORY CREAM " +
"BLUE RED GREEN YELLOW PINK PURPLE BROWN TAN SAND STONE SILVER GOLD COPPER NAVY TEAL MINT RUST MUSTARD CHARCOAL " +
"ANTHRACITE ANTRASIT MARBLE STRAW ROSE LGREY DGREY OFFWHITE CREME SMOKE SAGE OLIVE LINEN AQUA LIGHT DARK BONE " +
"CLAY DENIM INDIGO PLUM WINE CARAMEL COGNAC MOCHA LATTE PEARL").split(" "));
const _RUIDO = new Set(["APP","REF","COD","DIS","SEL","MTS","MT","CMS","PZA","UND","STD","EXT","PROMO"]);

function _lim(s){ return String(s||"").replace(/ /g," ").replace(/\s+/g," ").replace(/^[\s.,-]+|[\s.,-]+$/g,""); }
function _esColor(t){
  const u = _lim(t).toUpperCase();
  if (!u || _RUIDO.has(u)) return false;
  return u.split(/[/\-]/).some(p => p && _COLORES.has(p.replace(/^[LD]\./, "")));
}
function parsearNombre(raw) {
  let n = _lim(raw);
  const outlet = _SEL2.test(n);
  n = _lim(n.replace(_SEL2, " "));
  let medida = "", color = "", base = n;
  const m = _MED.exec(n);
  if (m) {
    medida = [m[1], m[2], m[3]].filter(Boolean).map(x => String(+x)).join("X");
    base = _lim(n.slice(0, m.index));
    const resto = _lim(n.slice(m.index + m[0].length));
    color = resto.split(/\s+/).map(t => _lim(t))
      .filter(t => t.length >= 3 && !/\d/.test(t) && !_RUIDO.has(t.toUpperCase())).join(" ");
    if (!base) { base = color || n; color = ""; }
  } else {
    for (const [re, val] of _TALLAS) {
      const mm = re.exec(base);
      if (mm) { medida = val; base = _lim(base.slice(0, mm.index) + " " + base.slice(mm.index + mm[0].length)); break; }
    }
    const toks = base.split(/\s+/), cola = [];
    while (toks.length > 1 && _esColor(toks[toks.length - 1])) cola.unshift(toks.pop());
    if (cola.length) { color = cola.join(" "); base = toks.join(" "); }
  }
  const partes = [medida, color].filter(Boolean);
  if (outlet) partes.push("2ª SELECCIÓN");
  return { nombre: _lim(base) || _lim(raw), descripcion: partes.join(" · "), outlet: outlet };
}


/* Clasificación de categoría al importar (espeja el ETL del catálogo) */
const _CLASES = [
  [/FLETE|DESPACHO|INSTALACION|INSTALACIÓN|DEVOLUCION|DEVOLUCIÓN|TOMA DE MEDIDAS|\bBOLSA\b|SERVICIO/i, "⚠ Servicios y logística"],
  [/^PROMOCION|^PROMOCIÓN/i, "Promociones"],
  [/PISO LAMINADO|PISO VINIL|PISO SPC|\bSPC\b|ROLLO PISO|ROLLO HARMONY|MOLDURA|GUARDAPOLVO/i, "Pisos laminados"],
  [/\bLIM\.?\b|LIMPIAPIE|ANTIDES|PROTECTOR PISO|MAGIC CLEAN|KITCHEN MAT|\bPISO\b|\bGOMA\b/i, "Limpiapiés y pisos"],
  [/TOALLA|TOALLON|\bBATA\b|CORTINA BAÑO|P\.CEPILLOS|DISPENSADOR|JABONERA|BASURERO/i, "Baño"],
  [/SABANA|SÁBANA|PLUMON|PLUMÓN|COBERTOR|QUILT|CUBRECAMA|FRAZADA|\bMANTA\b|ALMOHADA|CUBRE COLCHON|CUBRE COLCHÓN|\bFUNDA\b|EDREDON|EDREDÓN|TOPPER|PIE DE CAMA|\bJGO\.? ?SAB/i, "Ropa de cama"],
  [/CORTINA|\bVELO\b|ROLLER|\bTELA\b|GASA|TREVIRA|RUSTICO|CHINTZ|COTTON|LINEN|\bBARRA\b|\bRIEL\b|BLACKOUT|B\.OUT|SUNSCREEN|PANEL JAPONES/i, "Cortinas y telas"],
  [/\bSOFA\b|SILLON|SILLÓN|\bMESA\b|\bSILLA\b|BUFFET|ALACENA|COMEDOR|VELADOR|ESTANTE|REPISA|\bCAMA\b|RESPALDO|\bPOUF\b|BANQUETA|ESCRITORIO|MUEBLE|CÓMODA|COMODA|\bRACK\b/i, "Muebles"],
  [/CUADRO|MACETERO|ESPEJO|JARRON|JARRÓN|CESTO|FLORERO|\bVASO\b|CANDELABRO|PORTARETRATO|\bRELOJ\b|LAMPARA|LÁMPARA|\bVELA\b|ADORNO|FIGURA/i, "Decoración"],
  [/INDIVIDUAL|MANTEL|CAMINO DE MESA|SERVILLETA|POSAVASO|BAJOPLATO/i, "Mesa y cocina"],
  [/CARTERA|MOCHILA|NECESER|ORGANIZADOR/i, "Accesorios"],
  [/PLAYMAT|\bKIDS\b|JUVENIL|INFANTIL/i, "Infantil"],
  [/DHURRIE|\bDH\.|KELIM|KILIM|\bJUTE\b|HANDWOVEN|\bSISAL\b|SEAGRASS|CUERO VACA|LEATHER PATCH/i, "Alfombras artesanales"]
];
const _PREFIJO = { C:"Alfombras", c:"Alfombras", B:"Alfombras artesanales", R:"Ropa de cama", r:"Ropa de cama",
  T:"Ropa de cama", H:"Limpiapiés y pisos", Y:"Accesorios", D:"Decoración", M:"Muebles", U:"Muebles",
  V:"Muebles", m:"Muebles", P:"Pisos laminados", J:"Cortinas y telas", K:"Cortinas y telas",
  I:"Cortinas y telas", S:"Cortinas y telas", y:"Decoración", Q:"⚠ Servicios y logística",
  F:"⚠ Servicios y logística", O:"⚠ Servicios y logística", X:"Promociones" };
function clasificar(nombre, sku) {
  for (const [re, cat] of _CLASES) if (re.test(nombre)) return cat;
  return _PREFIJO[(sku || " ")[0]] || "Otros";
}

/* normaliza encabezados: quita tildes, guiones bajos y espacios múltiples */
function normH(s) { return norm(s).replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim(); }

function mapearEncabezados(head) {
  const map = {};
  head.forEach((h, i) => {
    const n = normH(h);
    if (!n) return;
    for (const campo in CAMPOS) {
      if (map[campo] !== undefined) continue;
      if (normH(campo) === n || CAMPOS[campo].some(a => normH(a) === n)) { map[campo] = i; return; }
    }
  });
  /* segunda pasada: coincidencia parcial */
  head.forEach((h, i) => {
    const n = normH(h); if (!n) return;
    if (Object.keys(map).some(k => map[k] === i)) return;
    for (const campo in CAMPOS) {
      if (map[campo] !== undefined) continue;
      if (CAMPOS[campo].some(a => normH(a).length >= 6 && n.includes(normH(a)))) { map[campo] = i; return; }
    }
  });
  return map;
}

function toNum(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  let s = String(v).trim().replace(/\$/g, "").replace(/\s/g, "").replace(/%/g, "");
  if (s === "") return null;
  /* formato chileno: 1.234.567,89  →  1234567.89 */
  if (/,/.test(s) && /\./.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/,/.test(s)) s = s.replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/* filas -> productos normalizados */
function filasAProductos(rows) {
  if (!rows.length) return { productos: [], aviso: "Archivo vacío." };
  /* buscar la fila de encabezado: la primera con >=2 campos reconocidos */
  let hi = 0, mapa = null;
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const m = mapearEncabezados(rows[i]);
    const k = Object.keys(m).length;
    if (k >= 3 && (m.nombre !== undefined || m.sku !== undefined)) { hi = i; mapa = m; break; }
  }
  if (!mapa) {
    /* diagnóstico: ¿es una hoja de maquetación de etiquetas en vez de una tabla? */
    const celdasTexto = rows.flat().filter(c => String(c).trim() !== "").length;
    const densidad = celdasTexto / Math.max(1, rows.length);
    const maquetada = densidad < 4;
    return {
      productos: [], maquetada: maquetada,
      aviso: maquetada
        ? "Este archivo parece una hoja de maquetación de etiquetas (texto suelto sobre celdas), no una tabla de datos."
        : "No se reconocieron las columnas: falta una fila de encabezados con al menos 'nombre' o 'sku' y un precio."
    };
  }

  const get = (r, c) => (mapa[c] === undefined ? "" : (r[mapa[c]] == null ? "" : String(r[mapa[c]]).trim()));
  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i];
    const nombre = get(r, "nombre") || get(r, "descripcion");
    const sku = get(r, "sku");
    if (!nombre && !sku) continue;
    const pn = toNum(get(r, "precio_normal"));
    const dct = toNum(get(r, "descuento"));
    let po = toNum(get(r, "precio_oferta"));
    /* export de Odoo: viene precio de lista + % de descuento, sin precio final */
    if (po == null && pn != null && dct != null && dct > 0)
      po = redondear(pn * (1 - dct / 100), APP.cfg.redondeo || "peso");
    let gr = get(r, "grupo") || "", de = get(r, "descripcion"), nom = nombre;
    if (!de) { const pr = parsearNombre(nombre); nom = pr.nombre; de = pr.descripcion; }
    if (!gr) gr = nom;
    const p = {
      sku: sku || ("AUTO-" + String(i).padStart(4, "0")),
      nombre: nom,
      grupo: gr,
      descripcion: de,
      marca: get(r, "marca"),
      categoria: get(r, "categoria") || clasificar(nombre, sku),
      subcategoria: get(r, "subcategoria"),
      lista: pn != null ? pn : po,
      precio_normal: pn,
      precio_oferta: po,
      descuento: dct,
      dto: dct != null ? dct : (pn != null && po != null && pn > 0 ? Math.round((1 - po / pn) * 10000) / 100 : 0),
      unidad: get(r, "unidad"),
      ppum_valor: toNum(get(r, "ppum_valor")),
      ppum_unidad: get(r, "ppum_unidad"),
      vig_desde: get(r, "vig_desde"),
      vig_hasta: get(r, "vig_hasta"),
      promo_texto: get(r, "promo_texto"),
      estado: (get(r, "estado") || (clasificar(nombre, sku).charAt(0) === "\u26A0" ? "inactivo" : "activo")).toLowerCase(),
      tienda: get(r, "tienda"),
      legal: get(r, "legal")
    };
    out.push(normalizarProducto(p));
  }
  return { productos: out, aviso: null, columnas: Object.keys(mapa) };
}

/* ---------- Redondeo comercial del precio con descuento ---------- */
const REDONDEOS = {
  peso:    { etiqueta: "Al peso ($1)",            fn: v => Math.round(v) },
  decena:  { etiqueta: "A la decena ($10)",       fn: v => Math.round(v / 10) * 10 },
  centena: { etiqueta: "A la centena ($100)",     fn: v => Math.round(v / 100) * 100 },
  t990:    { etiqueta: "Terminación 990",         fn: v => {
      if (v < 1000) return Math.max(0, Math.round(v / 10) * 10 - 10) + 9;
      const mil = Math.round((v - 990) / 1000);
      return Math.max(990, mil * 1000 + 990);
    } }
};
function redondear(v, modo) {
  const r = REDONDEOS[modo] || REDONDEOS.peso;
  return r.fn(v);
}
/* Recalcula el precio vigente desde lista + descuento con el redondeo activo */
function recalcularPrecios() {
  const modo = APP.cfg.redondeo || "peso";
  APP.productos.forEach(p => {
    if (p.dto != null && p.lista != null) {
      p.precio_normal = p.lista;
      p.precio_oferta = redondear(p.lista * (1 - p.dto / 100), modo);
      normalizarProducto(p);
    }
  });
  aplicarVigencia();
  indexar();
}

/* Regla de negocio central: qué es "precio vigente" y qué es "precio anterior".
   Si sólo hay un precio, ese es el vigente y no hay oferta. */
function normalizarProducto(p) {
  let pn = p.precio_normal, po = p.precio_oferta;
  /* precio de lista estable: sobrevive aunque el producto no tenga oferta */
  if (p.lista == null) p.lista = (pn != null ? pn : po);
  if (pn != null && po == null) { po = pn; pn = null; }        /* un solo precio */
  if (pn != null && po != null && po >= pn) { pn = null; }      /* "oferta" que no descuenta */
  p.precio_normal = pn;   /* precio anterior / lista (puede ser null) */
  p.precio_vigente = po;  /* lo que paga el cliente hoy */
  p.en_oferta = pn != null && po != null && po < pn;
  if (p.en_oferta) {
    const calc = pct(pn, po);
    if (p.descuento == null || Math.abs(p.descuento - calc) > 1) p.descuento_calc = calc;
    else p.descuento_calc = p.descuento;
  } else { p.descuento_calc = null; }
  return p;
}

/* ================================================================
   VALIDADOR — bloquea la generación cuando el dato no es confiable
   ================================================================ */
function validar(p, cfg) {
  const errs = [], warns = [];
  const hoy = hoyISO();

  if (!p.nombre) errs.push("El producto no tiene nombre.");
  if (p.precio_vigente == null) errs.push("El producto no tiene precio vigente.");
  else if (p.precio_vigente < 0) errs.push("El precio es negativo (" + p.precio_vigente + ").");
  else if (p.precio_vigente === 0) warns.push("El precio es $0. Verifica que sea correcto.");
  else if (!Number.isInteger(p.precio_vigente)) warns.push("El precio tiene decimales; el peso chileno no los usa. Se redondeará a " + clp(p.precio_vigente) + ".");

  if (p.estado && ["inactivo", "0", "no", "false", "descontinuado"].includes(p.estado))
    errs.push("Este ítem no es imprimible: está marcado como INACTIVO (servicio, flete o material de embalaje).");

  if (p.precio_normal != null && p.precio_vigente != null && p.precio_normal <= p.precio_vigente)
    warns.push("El precio anterior no es mayor al vigente: no se mostrará como oferta.");

  if (p.vig_hasta && String(p.vig_hasta).slice(0, 10) < hoy)
    errs.push("La promoción venció el " + fechaCL(p.vig_hasta) + ".");
  if (p.vig_desde && String(p.vig_desde).slice(0, 10) > hoy)
    warns.push("La promoción empieza recién el " + fechaCL(p.vig_desde) + ".");


  if (p.descuento != null && p.descuento_calc != null && Math.abs(p.descuento - p.descuento_calc) > 1)
    warns.push("El descuento declarado (" + p.descuento + "%) no coincide con el calculado (" + p.descuento_calc + "%). Se usará el calculado.");

  if (cfg && cfg.antiguedad_max && p.actualizado) {
    const dias = Math.floor((Date.now() - new Date(p.actualizado)) / 86400000);
    if (dias > cfg.antiguedad_max) warns.push("El precio no se actualiza hace " + dias + " días.");
  }
  const glob = [];
  if (p.en_oferta && !p.vig_hasta && !(cfg && cfg.vig_hasta))
    glob.push("Oferta sin fecha de término.");
  return { errs, warns, glob, ok: errs.length === 0 };
}

/* ================================================================
   ESTADO DE LA APLICACIÓN
   ================================================================ */
const APP = {
  productos: [],
  cfg: {
    empresa: "DIB",
    tienda: "Tienda 001",
    usuario: "Usuario tienda",
    rojo: "#FF5050",
    banda: "#F2F2F2",
    tinta: "#000000",
    fuente: "Arial, Helvetica, sans-serif",
    fuente_alt: "'Open Sans','Segoe UI',Arial,sans-serif",
    legal: "Precios incluyen IVA. Válido hasta agotar stock.",
    mostrar_sku: false,
    mostrar_ppum: true,
    antiguedad_max: 30,
    marcas_corte: true,
    sangrado: 0,
    redondeo: "peso",
    tachar: true,
    vig_desde: "",
    vig_hasta: ""
  },
  sel: null,        /* producto seleccionado */
  selGrupo: null,   /* grupo seleccionado (plantillas de lista) */
  tpl: null,        /* plantilla elegida */
  seleccion: new Set(),
  grupos: new Map(),
  historial: [],
  catalogoMeta: { origen: "demo", fecha: hoyISO(), filas: 0 }
};

/* ================================================================
   CARGA DEL CATÁLOGO EMBEBIDO
   Formato TSV compacto:  sku \t idxNombre \t descripcion \t idxCategoria
                          \t precioLista \t descuento \t flags
   flags: 1 = 2ª selección   2 = no imprimible (servicios/logística)
   ================================================================ */
function cargarEmbebido() {
  const M = CATALOGO.meta, N = CATALOGO.nombres, C = CATALOGO.cats;
  const hoy = hoyISO();
  const out = [];
  const filas = CATALOGO.tsv.split("\n");
  for (let i = 0; i < filas.length; i++) {
    const f = filas[i];
    if (!f) continue;
    const c = f.split("\t");
    const lista = +c[4], dto = +c[5] || 0, fl = +c[6] || 0;
    const p = {
      sku: c[0],
      nombre: N[+c[1]],
      grupo: N[+c[1]],
      descripcion: c[2],
      categoria: C[+c[3]],
      marca: "",
      lista: lista,
      precio_normal: lista,
      precio_oferta: redondear(lista * (1 - dto / 100), APP.cfg.redondeo || "peso"),
      dto: dto,
      descuento: null,
      unidad: "", ppum_valor: null, ppum_unidad: "",
      vig_desde: "", vig_hasta: "", promo_texto: "",
      estado: (fl & 2) ? "inactivo" : "activo",
      outlet: !!(fl & 1),
      tienda: "", legal: "",
      actualizado: M.fecha
    };
    out.push(normalizarProducto(p));
  }
  APP.productos = out;
  APP.catalogoMeta = { origen: M.origen, fecha: M.fecha, filas: out.length, lista: M.lista, codigo: M.codigo };
  aplicarVigencia();
  indexar();
}

/* Vigencia de campaña: una sola fecha para toda la lista (art. 35 Ley 19.496) */
function aplicarVigencia() {
  const d = APP.cfg.vig_desde || "", h = APP.cfg.vig_hasta || "";
  APP.productos.forEach(p => {
    if (p.en_oferta) { p.vig_desde = d; p.vig_hasta = h; }
  });
}

/* Índices: búsqueda rápida y agrupación por familia sobre 10.000+ SKU */
function indexar() {
  APP.grupos = new Map();
  APP.productos.forEach(p => {
    p._hay = norm([p.sku, p.nombre, p.descripcion, p.marca, p.categoria].join(" "));
    const g = p.grupo || p.categoria || p.nombre;
    if (!APP.grupos.has(g)) APP.grupos.set(g, []);
    APP.grupos.get(g).push(p);
  });
}
/* ================================================================
   MOTOR DE PLANTILLAS
   Todo se dibuja en SVG con el viewBox en MILÍMETROS.
   1 unidad SVG = 1 mm  →  el tamaño físico es exacto por construcción.
   ================================================================ */

const PT = 0.3527777778;            /* 1 punto tipográfico en mm */
const _mctx = document.createElement("canvas").getContext("2d");

/* ancho del texto por unidad de tamaño de fuente (todo en mm) */
function _ratio(txt, fam, weight) {
  _mctx.font = (weight ? weight + " " : "") + "100px " + fam;
  return _mctx.measureText(String(txt)).width / 100;
}
/* tamaño de fuente (mm) que hace caber `txt` en `maxW` mm, sin pasar de `ideal` */
function fitSize(txt, fam, weight, maxW, ideal, minFactor) {
  const r = _ratio(txt, fam, weight);
  if (!r) return ideal;
  return Math.max(ideal * (minFactor || 0.45), Math.min(ideal, maxW / r));
}
function anchoTexto(txt, fam, weight, size, ls) {
  let w = _ratio(txt, fam, weight) * size;
  if (ls) w += ls * Math.max(0, String(txt).length - 1);
  return w;
}

/* elemento <text> */
function T(x, y, txt, o) {
  o = o || {};
  const a = [];
  a.push('x="' + r3(x) + '" y="' + r3(y) + '"');
  a.push('font-family="' + (o.fam || APP.cfg.fuente) + '"');
  a.push('font-size="' + r3(o.size) + '"');
  if (o.weight) a.push('font-weight="' + o.weight + '"');
  a.push('fill="' + (o.fill || APP.cfg.tinta) + '"');
  if (o.anchor) a.push('text-anchor="' + o.anchor + '"');
  if (o.ls) a.push('letter-spacing="' + r3(o.ls) + '"');
  if (o.deco) a.push('text-decoration="' + o.deco + '"');
  a.push('dominant-baseline="alphabetic"');
  a.push('xml:space="preserve"');
  return "<text " + a.join(" ") + ">" + esc(txt) + "</text>";
}
function R(x, y, w, h, fill, extra) {
  return '<rect x="' + r3(x) + '" y="' + r3(y) + '" width="' + r3(w) + '" height="' + r3(h) + '" fill="' + fill + '"' + (extra || "") + "/>";
}
function L(x1, y1, x2, y2, col, sw) {
  return '<line x1="' + r3(x1) + '" y1="' + r3(y1) + '" x2="' + r3(x2) + '" y2="' + r3(y2) + '" stroke="' + col + '" stroke-width="' + (sw || 0.2) + '"/>';
}
function r3(n) { return Math.round(Number(n) * 1000) / 1000; }

/* ----------------------------------------------------------------
   BADGE "% OFF" — componente reutilizable, réplica del que usan hoy
   ---------------------------------------------------------------- */
function badgeOff(x, y, w, h, num, cfg) {
  const rojo = cfg.rojo, fam = cfg.fuente;
  let s = R(x, y, w, h, rojo);
  const n = String(Math.round(num));
  const CAP = 0.716;                       /* altura de mayúscula Arial ≈ 0.716 em */
  const gap = Math.min(w, h) * 0.055;
  const cy = y + h / 2;

  /* pila «%» sobre «OFF», ajustada por medición real de ancho */
  const stackW = Math.min(w * 0.30, h * 0.48);
  const pctSize = stackW / Math.max(0.01, _ratio("%", fam, "bold"));
  const offSize = stackW / Math.max(0.01, _ratio("OFF", fam, "bold"));
  const inter = pctSize * 0.10;
  const stackH = pctSize * CAP + inter + offSize * CAP;
  const pctBase = cy - stackH / 2 + pctSize * CAP;
  const offBase = pctBase + inter + offSize * CAP;

  /* el número ocupa todo lo que queda a la izquierda */
  const numW = w - stackW - gap * 3;
  const numSize = Math.min(fitSize(n, fam, "bold", numW, h * 1.2, 0.2), h * 0.80 / CAP);
  const numX = x + gap + numW;
  s += T(numX, cy + numSize * CAP / 2, n, { size: numSize, weight: "bold", fill: "#FFFFFF", anchor: "end", fam: fam });

  const sx = numX + gap;
  s += T(sx, pctBase, "%",   { size: pctSize, weight: "bold", fill: "#FFFFFF", anchor: "start", fam: fam });
  s += T(sx, offBase, "OFF", { size: offSize, weight: "bold", fill: "#FFFFFF", anchor: "start", fam: fam });
  return s;
}

/* Código del producto. Va siempre visible: permite verificar en sala que la
   etiqueta corresponde al producto, y es la llave contra Odoo. */
function codigoSKU(x, y, sku, cfg, pt, anchor) {
  if (!sku) return "";
  return T(x, y, String(sku), {
    size: (pt || 5.5) * PT, fill: "#8A8F9A", anchor: anchor || "start",
    fam: cfg.fuente, ls: 0.06
  });
}

/* pie legal / vigencia — obligación art. 35 Ley 19.496 */
function pieLegal(w, h, p, cfg, opt) {
  opt = opt || {};
  const size = (opt.size || 5) * PT;
  const partes = [];
  if (p.en_oferta && p.vig_hasta) partes.push("Oferta válida hasta el " + fechaCL(p.vig_hasta));
  if (cfg.legal) partes.push(cfg.legal);
  if (!partes.length) return "";
  const txt = partes.join("  ·  ");
  const mx = opt.mx == null ? 4 : opt.mx;
  const fs = fitSize(txt, cfg.fuente, "", w - mx * 2, size, 0.6);
  return T(opt.anchor === "start" ? mx : w / 2, h - (opt.my == null ? 2.2 : opt.my), txt,
    { size: fs, fill: "#8A8F9A", anchor: opt.anchor || "middle", fam: cfg.fuente });
}

/* PPUM — Decreto 38/2024: altura ≥ 50% del precio y nunca < 5 mm */
function bloquePPUM(x, y, p, cfg, precioSizeMM, anchor) {
  if (!cfg.mostrar_ppum) return "";
  const txt = ppumTexto(p);
  if (!txt) return "";
  const size = Math.max(5 * 0.72, precioSizeMM * 0.5);  /* 5 mm de alto de carácter ≈ 0.72em en Arial */
  return T(x, y, txt, { size: size, fill: "#3A3F4B", anchor: anchor || "middle", fam: cfg.fuente });
}

function envolver(w, h, cuerpo, cfg, opt) {
  opt = opt || {};
  const borde = opt.borde === false ? "" :
    '<rect x="0.1" y="0.1" width="' + r3(w - 0.2) + '" height="' + r3(h - 0.2) + '" fill="none" stroke="#DDDDDD" stroke-width="0.2"/>';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + 'mm" height="' + h + 'mm" ' +
    'viewBox="0 0 ' + w + ' ' + h + '" data-w="' + w + '" data-h="' + h + '">' +
    R(0, 0, w, h, "#FFFFFF") + cuerpo + borde + "</svg>";
}

/* Descripción de cada línea. Ya no hace falta desambiguar las variantes que
   comparten medida: el SKU va impreso debajo de cada una y las distingue. */
function etiquetasVariante(items) {
  return items.map(p => (p.descripcion || p.nombre || "").toUpperCase());
}

/* Kicker: la familia si aporta información, si no la categoría */
function kicker(p) {
  const g = p.grupo || "";
  return (g && g !== p.nombre) ? g : (p.categoria || "");
}

/* ================================================================
   LAS 6 PLANTILLAS
   ================================================================ */
const TPLS = {};

/* ---------- 1) 15×8 cm · TEXTIL Y LIMPIAPIÉS · PVP NORMAL ---------- */
TPLS.TEX_LIM_NORMAL = {
  id: "TEX_LIM_NORMAL",
  nombre: "Textil y Limpiapiés · Precio normal",
  desc: "Cabecera de familia + hasta 5 variantes con su precio.",
  w: 150, h: 80, tipo: "lista", maxItems: 5, oferta: false,
  grupo: "Etiqueta de mueble / estante",
  render(d, cfg) {
    const w = this.w, h = this.h, fam = cfg.fuente;
    const items = d.items.slice(0, this.maxItems);
    let s = "";
    /* banda de cabecera */
    const bandaH = 16.6;
    s += R(0, 0, w, bandaH, cfg.banda);
    const tit = String(d.titulo || "").toUpperCase();
    const ts = fitSize(tit, fam, "bold", w - 12, 18 * PT, 0.45);
    s += T(w / 2, bandaH / 2 + ts * 0.355, tit, { size: ts, weight: "bold", anchor: "middle", fam: fam });

    const y0 = 24.3, rowH = 9.97, mx = 6;
    const etiq = etiquetasVariante(items);
    items.forEach((p, i) => {
      const cy = y0 + rowH * i + rowH / 2;
      const desc = etiq[i];
      const precio = clp(p.precio_vigente);
      const ps = 14 * PT;
      const pw = anchoTexto(precio, fam, "bold", ps);
      const ds = fitSize(desc, fam, "", w - mx * 2 - pw - 6, 11 * PT, 0.55);
      s += T(mx, cy + ds * 0.355 - 1.2, desc, { size: ds, fam: fam });
      s += codigoSKU(mx, cy + ds * 0.355 + 2.2, p.sku, cfg, 5);
      s += T(w - mx, cy + ps * 0.355, precio, { size: ps, weight: "bold", anchor: "end", fam: fam });
      const pp = ppumTexto(p);
      if (pp && cfg.mostrar_ppum) s += T(w - mx, cy + ds * 0.355 + 3.2, pp, { size: Math.max(3.6, ps * 0.5), fill: "#8A8F9A", anchor: "end", fam: fam });
    });
    s += pieLegal(w, h, items[0] || {}, cfg, { anchor: "start", mx: mx, size: 6 });
    return envolver(w, h, s, cfg);
  }
};

/* ---------- 2) 15×8 cm · TEXTIL Y LIMPIAPIÉS · PVP PROMO ---------- */
TPLS.TEX_LIM_PROMO = {
  id: "TEX_LIM_PROMO",
  nombre: "Textil y Limpiapiés · Oferta",
  desc: "Cabecera + variantes con precio antes / ahora y badge % OFF.",
  w: 150, h: 80, tipo: "lista", maxItems: 5, oferta: true,
  grupo: "Etiqueta de mueble / estante",
  render(d, cfg) {
    const w = this.w, h = this.h, fam = cfg.fuente;
    const items = d.items.slice(0, this.maxItems);
    const badgeW = 37, izq = w - badgeW;
    let s = "";
    const bandaH = 16.6;
    s += R(0, 0, izq, bandaH, cfg.banda);
    const tit = String(d.titulo || "").toUpperCase();
    const ts = fitSize(tit, fam, "bold", izq - 10, 18 * PT, 0.45);
    s += T(izq / 2, bandaH / 2 + ts * 0.355, tit, { size: ts, weight: "bold", anchor: "middle", fam: fam });

    /* badge con el descuento representativo del grupo */
    const dtos = items.map(p => p.descuento_calc).filter(x => x != null);
    const dto = dtos.length ? Math.max.apply(null, dtos) : null;
    if (dto) s += badgeOff(izq, 0, badgeW, h, dto, cfg);
    else s += R(izq, 0, badgeW, h, cfg.banda);

    const y0 = 24.3, rowH = 9.97, mx = 6;
    const xPromo = izq - 5, xNormal = izq - 5 - 27;
    const etiq = etiquetasVariante(items);
    items.forEach((p, i) => {
      const cy = y0 + rowH * i + rowH / 2;
      const desc = etiq[i];
      const ds = fitSize(desc, fam, "", xNormal - mx - 22, 11 * PT, 0.5);
      s += T(mx, cy + ds * 0.355 - 1.2, desc, { size: ds, fam: fam });
      s += codigoSKU(mx, cy + ds * 0.355 + 2.2, p.sku, cfg, 5);
      if (p.precio_normal != null) {
        const ns = 11 * PT;
        s += T(xNormal, cy + ns * 0.355, clp(p.precio_normal),
          { size: ns, fill: "#8A8F9A", anchor: "end", fam: fam, deco: cfg.tachar ? "line-through" : "" });
      }
      const ps = 14 * PT;
      s += T(xPromo, cy + ps * 0.355, clp(p.precio_vigente), { size: ps, weight: "bold", anchor: "end", fam: fam });
    });
    s += pieLegal(izq, h, items[0] || {}, cfg, { anchor: "start", mx: mx, size: 6 });
    return envolver(w, h, s, cfg);
  }
};

/* ---------- 3) 9×11 cm · ALFOMBRA VERTICAL ---------- */
TPLS.ALF_9X11 = {
  id: "ALF_9X11",
  nombre: "Alfombra vertical 9×11",
  desc: "Pieza individual: kicker, nombre grande, medida, precio antes y precio oferta.",
  w: 90, h: 110, tipo: "individual", oferta: null,
  grupo: "Cartel de producto",
  render(d, cfg) { return alfVertical(this.w, this.h, d, cfg, { kick: 11, nom: 30, med: 12, pn: 14, po: 48, badge: 25 }); }
};

/* ---------- 4) 6,5×9 cm · ALFOMBRA VERTICAL ---------- */
TPLS.ALF_65X9 = {
  id: "ALF_65X9",
  nombre: "Alfombra vertical 6,5×9",
  desc: "Versión compacta de la anterior, 3 por fila en la hoja.",
  w: 65, h: 90, tipo: "individual", oferta: null,
  grupo: "Cartel de producto",
  render(d, cfg) { return alfVertical(this.w, this.h, d, cfg, { kick: 9, nom: 24, med: 10, pn: 11, po: 36, badge: 21 }); }
};

function alfVertical(w, h, d, cfg, sz) {
  const p = d.item, fam = cfg.fuente;
  const oferta = p.en_oferta;
  const badgeH = oferta && p.descuento_calc ? sz.badge : 0;
  const util = h - badgeH;
  let s = "";
  const mx = w * 0.07;
  s += codigoSKU(mx * 0.6, h * 0.042, p.sku, cfg, w > 80 ? 6 : 5);

  /* kicker: categoría/grupo en versalitas espaciadas */
  const kick = String(kicker(p)).toUpperCase();
  let y = util * 0.13;
  if (kick) {
    let ks = sz.kick * PT, ls = ks * 0.42;
    while (anchoTexto(kick, fam, "", ks, ls) > w - mx * 2 && ks > sz.kick * PT * 0.5) { ks *= 0.94; ls = ks * 0.42; }
    s += T(w / 2 + ls / 2, y, kick, { size: ks, anchor: "middle", ls: ls, fam: fam, fill: "#3A3F4B" });
  }

  /* nombre del producto — se ajusta y parte en 2 líneas si hace falta */
  const nombre = String(p.nombre || "").toUpperCase();
  const maxW = w - mx * 2;
  let ns = fitSize(nombre, fam, "bold", maxW, sz.nom * PT, 0.42);
  y = util * 0.30;
  if (ns < sz.nom * PT * 0.62) {
    const parts = partirEnDos(nombre);
    let s2 = fitSize(parts[0], fam, "bold", maxW, sz.nom * PT, 0.42);
    s2 = Math.min(s2, fitSize(parts[1], fam, "bold", maxW, sz.nom * PT, 0.42));
    s += T(w / 2, y, parts[0], { size: s2, weight: "bold", anchor: "middle", fam: fam });
    s += T(w / 2, y + s2 * 1.08, parts[1], { size: s2, weight: "bold", anchor: "middle", fam: fam });
    y += s2 * 1.08;
  } else {
    s += T(w / 2, y, nombre, { size: ns, weight: "bold", anchor: "middle", fam: fam });
  }

  /* medida / color — nunca por encima de la última línea del nombre */
  const med = p.descripcion || "";
  if (med) {
    const ms = fitSize(med, fam, "", maxW, sz.med * PT, 0.6);
    s += T(w / 2, Math.max(util * 0.46, y + ms * 1.7), med, { size: ms, anchor: "middle", fam: fam });
  }

  /* precios */
  if (oferta && p.precio_normal != null) {
    const ps = sz.pn * PT;
    s += T(w / 2, util * 0.575, clp(p.precio_normal),
      { size: ps, anchor: "middle", fam: fam, fill: "#3A3F4B", deco: cfg.tachar ? "line-through" : "" });
  }
  const bigIdeal = sz.po * PT;
  const big = fitSize(clp(p.precio_vigente), fam, "bold", w - mx * 1.4, bigIdeal, 0.5);
  const bigY = oferta ? util * 0.80 : util * 0.72;
  s += T(w / 2, bigY, clp(p.precio_vigente),
    { size: big, weight: "bold", anchor: "middle", fam: fam, fill: oferta ? cfg.rojo : cfg.tinta });

  s += bloquePPUM(w / 2, bigY + big * 0.42 + 2, p, cfg, big, "middle");

  if (badgeH) {
    s += badgeOff(0, h - badgeH, w, badgeH, p.descuento_calc, cfg);
    s += pieLegal(w, h - badgeH, p, cfg, { size: 5.5, my: 1.5 });
  } else s += pieLegal(w, h, p, cfg, { size: 6 });
  return envolver(w, h, s, cfg);
}

function partirEnDos(txt) {
  const ws = String(txt).split(/\s+/);
  if (ws.length < 2) return [txt, ""];
  let best = 1, dif = 1e9;
  for (let i = 1; i < ws.length; i++) {
    const a = ws.slice(0, i).join(" ").length, b = ws.slice(i).join(" ").length;
    if (Math.abs(a - b) < dif) { dif = Math.abs(a - b); best = i; }
  }
  return [ws.slice(0, best).join(" "), ws.slice(best).join(" ")];
}

/* ---------- 5) 8×5 cm · MUEBLES (porta-etiqueta acrílico) ---------- */
TPLS.MUEBLES_8X5 = {
  id: "MUEBLES_8X5",
  nombre: "Muebles acrílico 8×5",
  desc: "Etiqueta chica para porta-precio acrílico. Tipografía Open Sans.",
  w: 80, h: 50, tipo: "individual", oferta: null,
  grupo: "Etiqueta pequeña",
  render(d, cfg) {
    const w = this.w, h = this.h, p = d.item;
    const fam = cfg.fuente_alt, famN = cfg.fuente;
    const oferta = p.en_oferta && p.descuento_calc;
    let s = "";
    const badgeW = oferta ? 24 : 0;
    const izq = w - badgeW;
    const mx = 4, maxW = izq - mx * 2;

    s += codigoSKU(2.6, 4.2, p.sku, cfg, 4.6);
    const cat = String(kicker(p)).toUpperCase();
    if (cat) {
      const cs = fitSize(cat, fam, "", maxW, 16 * PT, 0.5);
      s += T(izq / 2, 8.4, cat, { size: cs, anchor: "middle", fam: fam, fill: "#808080" });
    }
    const nom = String(p.nombre || "").toUpperCase();
    const ns = fitSize(nom, fam, "bold", maxW, 14 * PT, 0.45);
    s += T(izq / 2, 14.6, nom, { size: ns, weight: "bold", anchor: "middle", fam: fam });

    const med = p.descripcion || "";
    if (med) {
      const ms = fitSize(med, fam, "", maxW, 11 * PT, 0.55);
      s += T(izq / 2, 21.5, med, { size: ms, anchor: "middle", fam: fam, fill: "#3A3F4B" });
    }
    if (oferta && p.precio_normal != null) {
      s += T(izq / 2, 29.4, clp(p.precio_normal),
        { size: 12 * PT, anchor: "middle", fam: famN, fill: "#808080", deco: cfg.tachar ? "line-through" : "" });
    }
    const hayPPUM = cfg.mostrar_ppum && !!ppumTexto(p);
    const big = fitSize(clp(p.precio_vigente), famN, "bold", maxW, 32 * PT, 0.5);
    const bigY = (oferta ? 41.5 : 37) - (hayPPUM ? 4 : 0);
    s += T(izq / 2, bigY, clp(p.precio_vigente),
      { size: big, weight: "bold", anchor: "middle", fam: famN, fill: oferta ? cfg.rojo : cfg.tinta });
    s += bloquePPUM(izq / 2, bigY + big * 0.30 + 3.4, p, cfg, big, "middle");

    if (oferta) s += badgeOff(izq, 0, badgeW, h, p.descuento_calc, cfg);
    s += pieLegal(izq, h, p, cfg, { size: 4.6, my: 1.6, mx: 2.5 });
    return envolver(w, h, s, cfg);
  }
};

/* ---------- 6) 13×18 cm · ROLLER ---------- */
TPLS.ROLLER_13X18 = {
  id: "ROLLER_13X18",
  nombre: "Roller 13×18",
  desc: "Listado largo: hasta 10 variantes con precio antes y ahora.",
  w: 130, h: 180, tipo: "lista", maxItems: 10, oferta: null,
  grupo: "Cartel de sección",
  render(d, cfg) {
    const w = this.w, h = this.h, fam = cfg.fuente;
    const items = d.items.slice(0, this.maxItems);
    const hayOferta = items.some(p => p.en_oferta);
    let s = "";
    const bandaH = 18;
    s += R(0, 0, w, bandaH, cfg.banda);
    const tit = String(d.titulo || "").toUpperCase();
    const ts = fitSize(tit, fam, "bold", w - 12, 18 * PT, 0.45);
    s += T(w / 2, bandaH / 2 + ts * 0.355, tit, { size: ts, weight: "bold", anchor: "middle", fam: fam });

    const dtos = items.map(p => p.descuento_calc).filter(x => x != null);
    const dto = dtos.length ? Math.max.apply(null, dtos) : null;
    const badgeH = dto ? 30 : 0;

    const zonaY = bandaH + 8, mx = 7;
    const dispo = h - zonaY - badgeH - 14;
    const rowH = Math.max(9, Math.min(17, dispo / Math.max(items.length, 1)));
    const y0 = zonaY + Math.max(0, (dispo - rowH * items.length) / 2);   /* bloque centrado */
    const xPromo = w - mx, xNormal = w - mx - 26;

    const etiq = etiquetasVariante(items);
    items.forEach((p, i) => {
      const cy = y0 + rowH * i + rowH / 2;
      const desc = etiq[i];
      const ds = fitSize(desc, fam, "", xNormal - mx - 20, 10 * PT, 0.5);
      s += T(mx, cy + ds * 0.355 - 1.3, desc, { size: ds, fam: fam });
      s += codigoSKU(mx, cy + ds * 0.355 + 2.3, p.sku, cfg, 5.5);
      if (hayOferta && p.precio_normal != null) {
        s += T(xNormal, cy + 10 * PT * 0.355, clp(p.precio_normal),
          { size: 10 * PT, fill: "#808080", anchor: "end", fam: fam, deco: cfg.tachar ? "line-through" : "" });
      }
      const ps = 14 * PT;
      s += T(xPromo, cy + ps * 0.355, clp(p.precio_vigente),
        { size: ps, weight: "bold", anchor: "end", fam: fam, fill: p.en_oferta ? cfg.rojo : "#404040" });
      if (i < items.length - 1) s += L(mx, y0 + rowH * (i + 1), w - mx, y0 + rowH * (i + 1), "#EDEDED", 0.15);
    });

    if (badgeH) s += badgeOff(w / 2 - 34, h - badgeH - 8, 68, badgeH, dto, cfg);
    s += pieLegal(w, h, items[0] || {}, cfg, { size: 7 });
    return envolver(w, h, s, cfg);
  }
};

const TPL_ORDEN = ["ALF_9X11", "ALF_65X9", "MUEBLES_8X5", "TEX_LIM_NORMAL", "TEX_LIM_PROMO", "ROLLER_13X18"];

/* ¿la plantilla aplica al producto/grupo elegido? */
function tplAplica(t, ctx) {
  if (t.tipo === "individual") return true;
  return ctx.items && ctx.items.length > 0;
}

/* construye el contexto de datos que consume una plantilla */
function ctxPara(tpl, prod, productos) {
  if (tpl.tipo === "individual") return { item: prod, titulo: prod.grupo || prod.categoria };
  const g = prod.grupo || prod.categoria || prod.nombre;
  const items = (APP.grupos && APP.grupos.get(g)) || productos.filter(p => (p.grupo || p.categoria || p.nombre) === g);
  return { titulo: g, items: items.length ? items : [prod] };
}

/* ================================================================
   HOJAS DE IMPOSICIÓN  (varias etiquetas por hoja + marcas de corte)
   ================================================================ */
const PAPELES = {
  A4:        { nombre: "A4",           w: 210, h: 297 },
  A4L:       { nombre: "A4 horizontal",w: 297, h: 210 },
  CARTA:     { nombre: "Carta",        w: 216, h: 279 },
  CARTA_L:   { nombre: "Carta horiz.", w: 279, h: 216 },
  A5:        { nombre: "A5",           w: 148, h: 210 },
  MEDIA_CARTA:{nombre: "Media carta",  w: 216, h: 140 },
  A3:        { nombre: "A3",           w: 297, h: 420 },
  EXACTO:    { nombre: "Tamaño exacto de la etiqueta", w: 0, h: 0 }
};

function marcasCorte(x, y, w, h, largo) {
  const c = "#000000", sw = 0.12, g = 1.2, l = largo || 3;
  let s = "";
  [[x, y, -1, -1], [x + w, y, 1, -1], [x, y + h, -1, 1], [x + w, y + h, 1, 1]].forEach(p => {
    s += L(p[0] + p[2] * g, p[1], p[0] + p[2] * (g + l), p[1], c, sw);
    s += L(p[0], p[1] + p[3] * g, p[0], p[1] + p[3] * (g + l), c, sw);
  });
  return s;
}

/* Coloca N etiquetas en hojas del papel indicado. Devuelve array de SVG (una por hoja) */
function imponer(svgs, tpl, papelKey, cfg) {
  const P = PAPELES[papelKey];
  if (!P || papelKey === "EXACTO") {
    return svgs.map(s => ({ svg: s, w: tpl.w, h: tpl.h }));
  }
  const margen = 6, sep = cfg.marcas_corte ? 5 : 3;
  const cols = Math.max(1, Math.floor((P.w - margen * 2 + sep) / (tpl.w + sep)));
  const filas = Math.max(1, Math.floor((P.h - margen * 2 + sep) / (tpl.h + sep)));
  const porHoja = cols * filas;
  const offX = (P.w - (cols * tpl.w + (cols - 1) * sep)) / 2;
  const offY = (P.h - (filas * tpl.h + (filas - 1) * sep)) / 2;

  const hojas = [];
  for (let i = 0; i < svgs.length; i += porHoja) {
    const lote = svgs.slice(i, i + porHoja);
    let body = R(0, 0, P.w, P.h, "#FFFFFF");
    lote.forEach((s, k) => {
      const c = k % cols, f = Math.floor(k / cols);
      const x = offX + c * (tpl.w + sep), y = offY + f * (tpl.h + sep);
      const inner = s.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
      body += '<g transform="translate(' + r3(x) + ',' + r3(y) + ')">' + inner + "</g>";
      if (cfg.marcas_corte) body += marcasCorte(x, y, tpl.w, tpl.h);
    });
    hojas.push({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + P.w + 'mm" height="' + P.h + 'mm" viewBox="0 0 ' + P.w + ' ' + P.h + '" data-w="' + P.w + '" data-h="' + P.h + '">' + body + "</svg>",
      w: P.w, h: P.h
    });
  }
  return hojas;
}

function capacidadHoja(tpl, papelKey) {
  const P = PAPELES[papelKey];
  if (!P || papelKey === "EXACTO") return 1;
  const margen = 6, sep = APP.cfg.marcas_corte ? 5 : 3;
  const cols = Math.max(1, Math.floor((P.w - margen * 2 + sep) / (tpl.w + sep)));
  const filas = Math.max(1, Math.floor((P.h - margen * 2 + sep) / (tpl.h + sep)));
  if (tpl.w > P.w - margen * 2 || tpl.h > P.h - margen * 2) return 0;
  return cols * filas;
}
/* ================================================================
   CARTELERÍA DIB · VERSIÓN TIENDA
   Una sola pantalla: buscar → elegir formato → imprimir.
   Los precios llegan desde Odoo a través del catálogo publicado.
   ================================================================ */

let SEL = null, TPL_SEL = null, PAPEL_SEL = "EXACTO", COPIAS = 1;
let BANDEJA = [];   /* SKU marcados para imprimir juntos en una hoja */
/* nombres cortos, pensados para alguien que está en sala y no en marketing */
const NOMBRE_CORTO = {
  ALF_9X11:       "Cartel de producto",
  ALF_65X9:       "Cartel chico",
  MUEBLES_8X5:    "Etiqueta acrílico",
  TEX_LIM_NORMAL: "Listado de familia",
  TEX_LIM_PROMO:  "Listado en oferta",
  ROLLER_13X18:   "Listado grande"
};
/* ---------------- qué formatos puede usar cada familia ----------------
   Decisión de operaciones, no técnica: hay carteles que no calzan con
   ciertos productos y se prestan para equivocarse en sala.

   Se evalúan EN ORDEN y manda la primera que calza. Las reglas por nombre
   van antes que las de categoría a propósito: un cojín archivado en la
   línea ALFOMBRAS sigue siendo un cojín, y el cartel de alfombra no le
   sirve. Para cambiar esto basta editar la lista: cada regla dice qué
   formatos DEJA, no cuáles quita. */
const REGLAS_FORMATO = [
  /* Roller va primero: en Odoo aparece como "C. ROLLER", "C ROLLER",
     "CORTINA ROLLER" y "ROLLER DOBLE", que son el mismo producto escrito de
     cuatro formas. La regla busca la palabra ROLLER y las toma todas. */
  { que: "Cortinas roller",           nombre: /\broller\b/,             deja: ["ROLLER_13X18"] },
  { que: "Cojines y fundas de cojín", nombre: /\bcojin/,               deja: ["TEX_LIM_NORMAL"] },
  { que: "Fundas de sofá",            nombre: /\bfunda\s*(de\s*)?sofa/, deja: ["TEX_LIM_NORMAL"] },
  { que: "Plumones y fundas",         nombre: /\bplumon/,               deja: ["TEX_LIM_PROMO"] },
  { que: "Sábanas",                   nombre: /\bsabana/,               deja: ["TEX_LIM_NORMAL", "TEX_LIM_PROMO"] },
  { que: "Almohadas",                 nombre: /\balmohad/,              deja: ["TEX_LIM_NORMAL", "TEX_LIM_PROMO"] },
  /* Alfombras no lleva regla: usa los 6 formatos. Los cojines archivados en
     la línea ALFOMBRAS siguen tomando la regla de cojín, que va más arriba. */
];
function reglaDe(p) {
  const n = norm((p.nombre || "") + " " + (p.descripcion || ""));
  const c = (p.categoria || "").toUpperCase();
  return REGLAS_FORMATO.find(r => (r.nombre ? r.nombre.test(n) : r.categoria === c)) || null;
}

/* Líneas donde NO se agrupa por nombre: cada modelo tiene su propia tarjeta.
   En sofás cada modelo lleva su cartel, y con la tarjeta agrupada solo se
   podía mandar uno a la hoja compartida. */
const LINEAS_SIN_AGRUPAR = ["SOFAS"];
function agrupa(p) {
  return LINEAS_SIN_AGRUPAR.indexOf((p.categoria || "").toUpperCase()) < 0;
}

const POR_PAGINA = 200;      /* se dibujan de a tandas para no colgar el navegador */
let PAGINA = 1;
let RESULTADOS = [];   /* grupos {nombre, items[]} — una tarjeta por nombre */
let SUELTOS = 0;       /* cuántos SKU hay detrás de esos grupos */
let VARIANTES = [];    /* variantes del grupo abierto en la hoja */

/* ---------------- estado del catálogo ---------------- */
/* Los datos vienen EMBEBIDOS por actualizar_carteleria.py. No hay fetch:
   abrir el HTML desde file:// no permite pedirle nada a Odoo (CORS), y
   además así la herramienta funciona sin conexión. */
function pintarEstado(txt, err) {
  const e = $("#estado");
  e.className = "estado" + (err ? " err" : "");
  e.innerHTML = "<b></b><span>" + esc(txt) + "</span>";
}
function selloCorto(s) {
  if (!s) return "";
  const f = String(s).slice(0, 10), h = String(s).slice(11, 16);
  return (f === hoyISO() ? "hoy" : fechaCL(f)) + (h ? " " + h : "");
}
function toast(txt) {
  const d = document.createElement("div");
  d.className = "toast"; d.textContent = txt;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2600);
}

/* ---------------- búsqueda ---------------- */
/* La maestra trae tres niveles: Línea → Familia → Subfamilia. RUTA guarda
   dónde está parada la persona; null en un nivel significa «todo». */
/* Los define el catálogo: el generador de descartados antepone el motivo. */
let NIVELES = [
  { campo: "categoria",  rotulo: "Línea" },
  { campo: "familia",    rotulo: "Familia" },
  { campo: "subfamilia", rotulo: "Subfamilia" },
];
let RUTA = [];   /* p.ej. ["ALFOMBRAS", "ALF. KELIMES"] */

/* Rutas (línea/familia/subfamilia/motivo) con conteo, las entrega el backend (action=taxonomia). */
let RUTAS = [];
function enRuta(ruta) {
  return RUTAS.filter(r => ruta.every((v, i) => r[NIVELES[i].campo] === v));
}
function opcionesNivel(ruta) {
  const i = ruta.length;
  if (i >= NIVELES.length) return [];
  const campo = NIVELES[i].campo, m = {};
  enRuta(ruta).forEach(r => { const v = r[campo] || "—"; m[v] = (m[v] || 0) + (r.n || 1); });
  return Object.keys(m).sort((a, b) => m[b] - m[a] || a.localeCompare(b, "es"))
    .map(v => ({ v: v, n: m[v] }));
}
function pintarChips() {
  /* Un nivel con una sola opción no es una decisión: se baja solo. Queda
     visible en las migas, así que no se pierde de dónde viene. */
  let guarda = 0;
  while (RUTA.length < NIVELES.length && guarda++ < NIVELES.length) {
    const o = opcionesNivel(RUTA);
    if (o.length === 1) RUTA = RUTA.concat([o[0].v]); else break;
  }
  const nivel = RUTA.length;
  const ops = opcionesNivel(RUTA);
  /* migas: permiten volver a cualquier nivel de un clic */
  const migas = '<button class="miga" data-i="0">Todo el catálogo</button>' +
    RUTA.map((v, i) => '<span class="sep">›</span><button class="miga' +
      (i === RUTA.length - 1 ? " act" : "") + '" data-i="' + (i + 1) + '">' + esc(v) + "</button>").join("");
  const titulo = nivel < NIVELES.length
    ? NIVELES[nivel].rotulo + (ops.length ? " · " + ops.length : "")
    : "";
  $("#chips").innerHTML =
    '<div class="migas">' + migas + "</div>" +
    (ops.length
      ? '<p class="nivel">' + esc(titulo) + "</p>" +
        '<div class="chiprow">' + ops.map(x =>
          '<button class="chip" data-v="' + esc(x.v) + '">' + esc(x.v) +
          " (" + x.n.toLocaleString("es-CL") + ")</button>").join("") + "</div>"
      : "");
  $$("#chips .chip").forEach(b => b.onclick = () => {
    RUTA = RUTA.concat([b.dataset.v]); pintarChips(); buscar();
  });
  $$("#chips .miga").forEach(b => b.onclick = () => {
    RUTA = RUTA.slice(0, +b.dataset.i); pintarChips(); buscar();
  });
}
let _busq = 0;
async function buscar() {
  PAGINA = 1;
  const q = $("#q").value.trim();
  $("#clr").classList.toggle("hidden", !q);
  const box = $("#res");
  if (q.length < 2 && !RUTA.length) {
    RESULTADOS = [];
    box.innerHTML = '<div class="empty"><b>Busca un producto</b>Escribe al menos 2 letras, o elige una línea arriba.</div>';
    return;
  }
  const filtros = { tienda: TIENDA, modo: MODO, q: q, limit: 100 };
  RUTA.forEach((v, i) => { filtros[NIVELES[i].campo === "categoria" ? "linea" : NIVELES[i].campo] = v; });
  const id = ++_busq;
  box.classList.add("cargando");
  let r;
  try { r = await api("buscar", filtros); }
  catch (e) {
    if (id !== _busq) return;
    box.classList.remove("cargando");
    box.innerHTML = '<div class="empty"><b>' + esc(e.message) + "</b>" + esc(e.code || "") + "</div>";
    pintarEstado("Sin conexión con el backend", true);
    return;
  }
  if (id !== _busq) return;   /* llegó una búsqueda más nueva */
  box.classList.remove("cargando");
  pintarEstado("Precios en línea · " + selloCorto(r.fecha));
  RESULTADOS = r.grupos.map(g => ({
    nombre: g.nombre, categoria: g.linea, familia: g.familia, subfamilia: g.subfamilia,
    skus: g.skus || [], sku: g.sku || "", descripcion: g.descripcion || "", medidas: g.medidas || [],
    n: g.variantes, min: g.desde, max: g.hasta, oferta: g.en_oferta, dto: g.dto_max || 0,
    precio_normal: g.normal || null, motivo: g.motivo || ""
  }));
  SUELTOS = RESULTADOS.reduce((a, g) => a + g.n, 0);

  if (!RESULTADOS.length) {
    const porCat = RUTA.length > 0;
    box.innerHTML = '<div class="empty"><b>No encontramos ese producto</b>' +
      (porCat
        ? "Estás buscando solo dentro de " + esc(RUTA[RUTA.length - 1]) + ". " +
          '<button class="chip" id="quitarCat" style="margin-top:12px">Buscar en todas las categorías</button>'
        : "Prueba con menos palabras, o busca por el código del producto.") + "</div>";
    const qc = $("#quitarCat");
    if (qc) qc.onclick = () => { RUTA = []; pintarChips(); buscar(); };
    return;
  }
  box.innerHTML =
    '<div class="acciones"><button class="chip" id="addTodo">Agregar los ' +
      Math.min(RESULTADOS.length, 60) + " de esta vista a la hoja</button></div>" +
    '<div class="grid" id="grid"></div><div id="pie"></div>';
  $("#addTodo").onclick = async () => {
    for (const g of RESULTADOS.slice(0, 60)) await agregarBandeja(g.nombre, true);
    pintarBarra(); repintarMarcas();
  };
  pintarTanda(true, r.total >= 100);
  window.scrollTo({ top: 0, behavior: "instant" });
}

/* Dibuja la siguiente tanda. Se agrega al final en vez de rehacer todo:
   con 7.000 resultados, redibujar en cada clic se notaría. */
function pintarTanda(primera, truncado) {
  const desde = primera ? 0 : (PAGINA - 1) * POR_PAGINA;
  const hasta = Math.min(PAGINA * POR_PAGINA, RESULTADOS.length);
  const html = RESULTADOS.slice(desde, hasta)
    .map((g, k) => tarjeta(g, desde + k)).join("");
  $("#grid").insertAdjacentHTML("beforeend", html);
  $("#pie").innerHTML =
    '<p class="mas">' + RESULTADOS.length.toLocaleString("es-CL") + " producto(s)" +
      (SUELTOS > RESULTADOS.length ? " · " + SUELTOS.toLocaleString("es-CL") + " modelos en total" : "") +
      (truncado ? " · <b>se muestran los primeros 100: afina la búsqueda o elige una familia</b>" : "") + "</p>";
}
function tarjeta(g, i) {
  const n = g.n || 1;
  const resumen = n === 1
    ? (g.descripcion || "")
    : g.medidas.slice(0, 3).join(" · ") + (g.medidas.length > 3 ? " +" + (g.medidas.length - 3) : "");
  const precio = (g.min === g.max) ? clp(g.min) : "desde " + clp(g.min);
  const enBandeja = g.skus.some(s => BANDEJA.some(b => b.sku === s));
  return '<div class="pcard' + (enBandeja ? " enb" : "") + '" role="button" tabindex="0" data-g="' + i + '">' +
    '<button class="add" data-add="' + i + '" title="' +
      (enBandeja ? "Quitar de la hoja" : "Agregar a la hoja") + '">' +
      (enBandeja ? "✓" : "+") + "</button>" +
    '<span class="cat">' + esc(g.categoria || "") + "</span>" +
    "<h3>" + esc(g.nombre) + "</h3>" +
    (resumen ? '<span class="desc">' + esc(resumen) + "</span>" : "") +
    (g.motivo ? '<span class="desc" style="color:#8A5A00;font-weight:600">' + esc(g.motivo) + "</span>" : "") +
    '<span class="sku">' + (n > 1 ? n + " modelos" : esc(g.sku)) + "</span>" +
    '<span class="prices">' +
      '<span class="now' + (g.oferta ? " off" : "") + '">' + precio + "</span>" +
      (n === 1 && g.oferta && g.precio_normal ? '<span class="old">' + clp(g.precio_normal) + "</span>" : "") +
      (g.dto ? '<span class="dto">-' + g.dto + "%</span>" : "") +
    "</span></div>";
}

/* ---------------- grupos: se piden al backend al abrir la ficha ----------------
   APP.grupos guarda las variantes de cada grupo ya consultado (lo usan las
   plantillas de listado y la bandeja). Nunca se descarga el maestro completo. */
function adaptar(it, r) {
  return normalizarProducto({
    sku: it.sku, nombre: r.grupo, grupo: r.grupo, descripcion: it.descripcion || "",
    categoria: it.categoria || r.linea, familia: it.familia || r.familia, subfamilia: it.subfamilia || r.subfamilia,
    marca: "", descontinuado: !!it.descontinuado, stock: it.stock, motivo: it.motivo || "",
    lista: it.precio_normal, precio_normal: it.precio_normal, precio_oferta: it.precio_oferta,
    dto: it.dto || 0, descuento: it.dto || null, unidad: "",
    ppum_valor: it.ppum_valor, ppum_unidad: it.ppum_unidad || "",
    vig_desde: r.vig_desde || APP.cfg.vig_desde || "", vig_hasta: r.vig_hasta || APP.cfg.vig_hasta || "",
    promo_texto: "", estado: "activo", outlet: !!it.outlet, tienda: TIENDA, legal: r.legal || "",
    actualizado: r.fecha
  });
}
async function cargarGrupo(nombre) {
  if (APP.grupos.has(nombre)) return APP.grupos.get(nombre);
  const r = await api("producto", { tienda: TIENDA, modo: MODO, grupo: nombre }, { ttl: 30000 });
  if (r.legal) APP.cfg.legal = r.legal;
  const items = r.items.map(it => adaptar(it, r));
  APP.grupos.set(nombre, items);
  return items;
}

/* ---------------- bandeja: varios SKU en una misma hoja ----------------
   El caso real es reponer la señalética de una góndola: 12 alfombras
   distintas, todas en el mismo formato, aprovechando la hoja completa. */
function bandejaProductos() { return BANDEJA.slice(); }
async function agregarBandeja(nombreGrupo, soloAgregar) {
  const items = await cargarGrupo(nombreGrupo);
  const p = items[0]; if (!p) return;
  const i = BANDEJA.findIndex(b => b.sku === p.sku);
  if (i >= 0) { if (!soloAgregar) BANDEJA.splice(i, 1); }
  else BANDEJA.push(p);
}
/* Formatos que sirven para TODOS los seleccionados: si uno solo no admite un
   formato, ese formato no puede usarse para la hoja mezclada. */
function formatosBandeja() {
  const ps = bandejaProductos();
  if (!ps.length) return [];
  return TPL_ORDEN.map(id => TPLS[id]).filter(t =>
    ps.every(p => { const r = reglaDe(p); return !r || r.deja.indexOf(t.id) >= 0; }));
}
async function toggleBandeja(nombreGrupo) {
  try { await agregarBandeja(nombreGrupo, false); }
  catch (e) { toast(e.message); return; }
  pintarBarra();
}
function pintarBarra() {
  const n = BANDEJA.length;
  let b = $("#barra");
  if (!n) { if (b) b.remove(); $$(".pcard.enb").forEach(c => c.classList.remove("enb")); return; }
  if (!b) {
    b = document.createElement("div"); b.id = "barra"; b.className = "barra";
    document.body.appendChild(b);
  }
  const fs = formatosBandeja();
  b.innerHTML = '<span class="n">' + n + " cartel" + (n > 1 ? "es" : "") + " en la hoja</span>" +
    (fs.length
      ? '<button class="sec" id="verBandeja">Armar la hoja</button>'
      : '<span class="alerta">No hay un formato común a todos — quita alguno</span>') +
    '<button class="sec" id="vaciar">Vaciar</button>';
  $("#verBandeja") && ($("#verBandeja").onclick = abrirBandeja);
  $("#vaciar").onclick = () => { BANDEJA = []; pintarBarra(); repintarMarcas(); };
}
/* Marca las tarjetas ya dibujadas sin rehacer el listado completo. */
function repintarMarcas() {
  $$(".pcard").forEach(c => {
    const g = RESULTADOS[+c.dataset.g];
    if (!g) return;
    const on = g.skus.some(s => BANDEJA.some(b => b.sku === s));
    c.classList.toggle("enb", on);
    const a = c.querySelector(".add");
    if (a) { a.textContent = on ? "✓" : "+"; a.title = on ? "Quitar de la hoja" : "Agregar a la hoja"; }
  });
}

/* ---------------- hoja de impresión ---------------- */
function formatosPara(p) {
  const r = reglaDe(p);
  const permitidos = r ? TPL_ORDEN.filter(id => r.deja.indexOf(id) >= 0) : TPL_ORDEN.slice();
  const lista = permitidos.map(id => TPLS[id]).filter(t => {
    if (t.tipo === "individual") return true;
    const g = (APP.grupos && APP.grupos.get(p.grupo || p.categoria || p.nombre)) || [];
    return g.length > 1;   /* los listados sólo tienen sentido con varias variantes */
  });
  /* Si la regla deja solo listados y el producto es único, igual hay que poder
     imprimirlo: mejor un listado de una línea que una pantalla sin opciones. */
  return lista.length ? lista : permitidos.map(id => TPLS[id]);
}
async function abrirHoja(indice) {
  const g = RESULTADOS[+indice]; if (!g) return;
  let items;
  try { items = await cargarGrupo(g.nombre); }
  catch (e) { toast(e.message); return; }
  VARIANTES = items;
  SEL = items[0];
  const fs = formatosPara(SEL);
  TPL_SEL = fs.length ? fs[0].id : TPL_ORDEN[0];
  PAPEL_SEL = "EXACTO";
  COPIAS = 1;
  pintarHoja();
}
function cerrarHoja() { $("#panel").innerHTML = ""; document.body.style.overflow = ""; }

/* ---------------- hoja mezclada ---------------- */
let TPL_BAN = null, PAPEL_BAN = "A4";
function abrirBandeja() {
  const fs = formatosBandeja();
  if (!fs.length) return;
  if (!fs.some(t => t.id === TPL_BAN)) TPL_BAN = fs[0].id;
  if (capacidadHoja(TPLS[TPL_BAN], PAPEL_BAN) < 1) PAPEL_BAN = "A4";
  pintarBandeja();
}
function svgsBandeja() {
  const t = TPLS[TPL_BAN], out = [];
  bandejaProductos().forEach(p => {
    const ctx = ctxPara(t, p, APP.productos);
    if (t.tipo === "lista" && ctx.items.length > t.maxItems)
      out.push(t.render({ titulo: ctx.titulo, items: ctx.items.slice(0, t.maxItems) }, APP.cfg));
    else out.push(t.render(ctx, APP.cfg));
  });
  return out;
}
function pintarBandeja() {
  const t = TPLS[TPL_BAN], fs = formatosBandeja(), ps = bandejaProductos();
  document.body.style.overflow = "hidden";
  $("#panel").innerHTML =
    '<div class="bg" id="bg"><div class="hoja" style="position:relative">' +
      '<button class="cerrar" id="cerrar" title="Cerrar (Esc)">✕</button>' +
      '<div class="izq">' +
        '<p class="lbl">En la hoja (' + ps.length + ")</p>" +
        '<div class="vl" id="bl">' + ps.map((p, i) =>
          '<button data-q="' + i + '" title="Quitar"><b>' + esc(p.nombre) + "</b>" +
          "<span>" + esc(p.descripcion || p.sku) + " · " + clp(p.precio_vigente) + " ✕</span></button>").join("") + "</div>" +
        '<p class="lbl">Formato (igual para todos)</p>' +
        '<div class="fl" id="fl">' + fs.map(x =>
          '<button data-t="' + x.id + '"' + (TPL_BAN === x.id ? ' class="on"' : "") + ">" +
            "<span><b>" + esc(NOMBRE_CORTO[x.id] || x.nombre) + "</b>" +
            "<span>" + fmtCm(x.w) + " × " + fmtCm(x.h) + " cm</span></span></button>").join("") + "</div>" +
      "</div>" +
      '<div class="der">' +
        "<h2>Hoja con " + ps.length + " cartel" + (ps.length > 1 ? "es" : "") + "</h2>" +
        '<p class="sub">Distintos productos, todos del mismo tamaño</p>' +
        '<div class="prev" id="prev"></div>' +
        '<div class="acc">' +
          '<select class="hoja-sel" id="papel"></select>' +
          '<button class="big" id="imprimir">IMPRIMIR</button>' +
          '<button class="sec" id="pdf">Guardar PDF</button>' +
        "</div>" +
        '<p class="nota" id="nota"></p>' +
      "</div>" +
    "</div></div>";
  $("#cerrar").onclick = cerrarHoja;
  $("#bg").onclick = e => { if (e.target.id === "bg") cerrarHoja(); };
  $$("#fl button").forEach(b => b.onclick = () => { TPL_BAN = b.dataset.t; pintarBandeja(); });
  $$("#bl button").forEach(b => b.onclick = () => {
    BANDEJA.splice(+b.dataset.q, 1);
    pintarBarra(); repintarMarcas();
    if (!BANDEJA.length) cerrarHoja(); else abrirBandeja();
  });
  $("#papel").onchange = e => { PAPEL_BAN = e.target.value; previewBandeja(); };
  $("#imprimir").onclick = () => salidaBandeja(false);
  $("#pdf").onclick = () => salidaBandeja(true);
  previewBandeja();
}
function previewBandeja() {
  const t = TPLS[TPL_BAN], svgs = svgsBandeja();
  const opts = Object.keys(PAPELES).filter(k => k !== "EXACTO" && capacidadHoja(t, k) > 0);
  $("#papel").innerHTML = opts.map(k =>
    '<option value="' + k + '"' + (PAPEL_BAN === k ? " selected" : "") + ">" +
    PAPELES[k].nombre + " · " + capacidadHoja(t, k) + " por hoja</option>").join("");
  const hojas = imponer(svgs, t, PAPEL_BAN, APP.cfg);
  const cont = $("#prev");
  const maxW = Math.max(240, cont.clientWidth - 46), maxH = Math.max(200, cont.clientHeight - 46);
  const k = Math.min(maxW / (hojas[0].w * MM), maxH / (hojas[0].h * MM), 1.6);
  cont.innerHTML = hojas.map(h =>
    '<div class="paper" style="width:' + (h.w * MM * k) + "px;height:" + (h.h * MM * k) + 'px">' +
    h.svg.replace("<svg ", '<svg style="width:100%;height:100%;display:block" ') + "</div>").join("");
  const cap = capacidadHoja(t, PAPEL_BAN);
  const sobra = cap > 0 ? (cap - (svgs.length % cap || cap)) : 0;
  $("#nota").innerHTML = svgs.length + " cartel(es) · " + hojas.length + " hoja(s) · tamaño real " +
    fmtCm(t.w) + " × " + fmtCm(t.h) + " cm" +
    (sobra > 0 ? ' · <b>sobran ' + sobra + " espacio(s) en la última hoja</b>" : "") +
    ".<br>En el diálogo de impresión: márgenes <b>Ninguno</b>, escala <b>100%</b> y <b>gráficos de fondo</b> activados.";
}
function salidaBandeja(comoPDF) {
  const t = TPLS[TPL_BAN];
  imprimir(imponer(svgsBandeja(), t, PAPEL_BAN, APP.cfg));
  if (comoPDF) toast("Elige «Guardar como PDF» en el destino de impresión");
}

function pintarHoja() {
  const p = SEL, fs = formatosPara(p);
  const v = validar(p, APP.cfg);
  document.body.style.overflow = "hidden";
  $("#panel").innerHTML =
    '<div class="bg" id="bg"><div class="hoja" style="position:relative">' +
      '<button class="cerrar" id="cerrar" title="Cerrar (Esc)">✕</button>' +
      '<div class="izq">' +
        /* Cuando el nombre agrupa varios modelos, primero se elige cuál. */
        (VARIANTES.length > 1
          ? '<p class="lbl">Modelo · medida (' + VARIANTES.length + ")</p>" +
            '<div class="vl" id="vl">' + VARIANTES.map((x, i) =>
              '<button data-v="' + i + '"' + (x.sku === p.sku ? ' class="on"' : "") + ">" +
                "<b>" + esc(x.descripcion || x.sku) + "</b>" +
                "<span>" + esc(x.sku) + " · " + clp(x.precio_vigente) +
                (x.descuento_calc ? " · -" + x.descuento_calc + "%" : "") + "</span>" +
              "</button>").join("") + "</div>"
          : "") +
        '<p class="lbl">Formato del cartel</p>' +
        '<div class="fl" id="fl">' + fs.map(t =>
          '<button data-t="' + t.id + '"' + (TPL_SEL === t.id ? ' class="on"' : "") + '>' +
            '<span class="mini">' + mini(t, p) + "</span>" +
            "<span><b>" + esc(NOMBRE_CORTO[t.id] || t.nombre) + "</b>" +
            "<span>" + fmtCm(t.w) + " × " + fmtCm(t.h) + " cm</span></span>" +
          "</button>").join("") + "</div>" +
        /* que no parezca que faltan formatos por un error */
        (reglaDe(p) && fs.length < TPL_ORDEN.length
          ? '<p class="nota">' + esc(reglaDe(p).que) + ": formatos definidos por operaciones.</p>"
          : "") +
      "</div>" +
      '<div class="der">' +
        "<h2>" + esc(p.nombre) + "</h2>" +
        '<p class="sub">' + esc(p.descripcion || p.categoria || "") + ' · <b class="sku-b">' + esc(p.sku) + "</b></p>" +
        '<div class="pr">' +
          '<span class="now' + (p.en_oferta ? " off" : "") + '">' + clp(p.precio_vigente) + "</span>" +
          (p.en_oferta ? '<span class="old">' + clp(p.precio_normal) + "</span>" : "") +
          (p.descuento_calc ? '<span class="dto" style="font-size:14px;padding:4px 10px">-' + p.descuento_calc + "% OFF</span>" : "") +
        "</div>" +
        /* en el generador de descartados, decir por qué está fuera antes de imprimir */
        (p.motivo && p.motivo !== "IMPRIME"
          ? '<div class="aviso warn"><b>Fuera del catálogo:</b> ' + esc(p.motivo) +
            (p.stock != null ? " · quedan " + p.stock + " unidades" : " · sin unidades registradas") + "</div>"
          : "") +
        (v.errs.length ? '<div class="aviso err"><b>No se puede imprimir.</b> ' + esc(v.errs[0]) + "</div>" : "") +
        (!v.errs.length && v.warns.length ? '<div class="aviso warn">' + esc(v.warns[0]) + "</div>" : "") +
        '<div class="prev" id="prev"></div>' +
        '<div class="acc">' +
          '<span class="cant"><label for="copias">Copias</label>' +
            '<input id="copias" type="number" min="1" max="500" step="1" value="' + COPIAS + '"></span>' +
          '<select class="hoja-sel" id="papel"></select>' +
          '<button class="sec hidden" id="llenar"></button>' +
          '<button class="big" id="imprimir"' + (v.errs.length ? " disabled style=\"opacity:.4\"" : "") + ">" +
            '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><path d="M6 18H4v-6h16v6h-2"/><rect x="7" y="14" width="10" height="7"/></svg>' +
            "IMPRIMIR</button>" +
          '<button class="sec" id="pdf">Guardar PDF</button>' +
        "</div>" +
        '<p class="nota" id="nota"></p>' +
      "</div>" +
    "</div></div>";

  $("#cerrar").onclick = cerrarHoja;
  $("#bg").onclick = e => { if (e.target.id === "bg") cerrarHoja(); };
  $$("#fl button").forEach(b => b.onclick = () => { TPL_SEL = b.dataset.t; PAPEL_SEL = "EXACTO"; COPIAS = 1; pintarHoja(); });
  $$("#vl button").forEach(b => b.onclick = () => {
    SEL = VARIANTES[+b.dataset.v];
    /* si el modelo nuevo no admite el formato elegido, se cae al primero suyo */
    const fs2 = formatosPara(SEL);
    if (!fs2.some(t => t.id === TPL_SEL)) TPL_SEL = fs2.length ? fs2[0].id : TPL_ORDEN[0];
    pintarHoja();
  });
  /* Al cambiar de papel las copias se ajustan solas para llenar la hoja, que es
     lo que la gente quiere el 90% de las veces. Si ya lo tocó a mano, se respeta. */
  $("#papel").onchange = e => {
    const t = TPLS[TPL_SEL], antes = copiasPorDefecto(t, PAPEL_SEL);
    PAPEL_SEL = e.target.value;
    if (COPIAS === antes) COPIAS = copiasPorDefecto(t, PAPEL_SEL);
    pintarPreview();
  };
  $("#copias").oninput = e => {
    const n = parseInt(e.target.value, 10);
    COPIAS = isNaN(n) ? 1 : Math.min(500, Math.max(1, n));
    pintarPreview();
  };
  $("#llenar").onclick = () => { COPIAS = capacidadHoja(TPLS[TPL_SEL], PAPEL_SEL); pintarPreview(); };
  $("#imprimir").onclick = () => salida(false);
  $("#pdf").onclick = () => salida(true);
  pintarPreview();
}
function fmtCm(mm) { return String(mm / 10).replace(".", ","); }
function mini(t, p) {
  try {
    return t.render(ctxPara(t, p, APP.productos), APP.cfg)
      .replace(/^<svg [^>]*>/, m => m.replace(/ width="[^"]*"/, "").replace(/ height="[^"]*"/, "")
        .replace("<svg ", '<svg preserveAspectRatio="xMidYMid meet" '));
  } catch (e) { return ""; }
}
function svgsActuales() {
  const t = TPLS[TPL_SEL], ctx = ctxPara(t, SEL, APP.productos);
  if (t.tipo === "lista" && ctx.items.length > t.maxItems) {
    const out = [];
    for (let i = 0; i < ctx.items.length; i += t.maxItems)
      out.push(t.render({ titulo: ctx.titulo, items: ctx.items.slice(i, i + t.maxItems) }, APP.cfg));
    return out;
  }
  return [t.render(ctx, APP.cfg)];
}
/* Cuántas veces se repite el cartel. Por defecto se llena la hoja: elegir A4
   e imprimir una sola etiqueta desperdiciaba el resto del papel. */
function copiasPorDefecto(t, papel) {
  return papel === "EXACTO" ? 1 : Math.max(1, capacidadHoja(t, papel));
}
function svgsParaImprimir() {
  const base = svgsActuales();
  const n = Math.max(1, COPIAS | 0);
  const out = [];
  for (let i = 0; i < n; i++) out.push.apply(out, base);
  return out;
}
function pintarPreview() {
  const t = TPLS[TPL_SEL];
  const opts = ["EXACTO"].concat(Object.keys(PAPELES).filter(k => k !== "EXACTO" && capacidadHoja(t, k) > 0));
  $("#papel").innerHTML = opts.map(k =>
    '<option value="' + k + '"' + (PAPEL_SEL === k ? " selected" : "") + ">" +
    (k === "EXACTO" ? "Una etiqueta suelta" : PAPELES[k].nombre + " · " + capacidadHoja(t, k) + " por hoja") + "</option>").join("");

  const cap = capacidadHoja(t, PAPEL_SEL);
  const c = $("#copias");
  if (c) {
    c.value = COPIAS;
    c.disabled = PAPEL_SEL === "EXACTO" && false;   /* también sirve suelto: N hojas */
    const llenar = $("#llenar");
    if (llenar) {
      llenar.classList.toggle("hidden", PAPEL_SEL === "EXACTO" || COPIAS === cap);
      llenar.textContent = "Llenar la hoja (" + cap + ")";
    }
  }

  const svgs = svgsParaImprimir();
  const hojas = imponer(svgs, t, PAPEL_SEL, APP.cfg);
  const cont = $("#prev");
  const maxW = Math.max(240, cont.clientWidth - 46), maxH = Math.max(200, cont.clientHeight - 46);
  const k = Math.min(maxW / (hojas[0].w * MM), maxH / (hojas[0].h * MM), 1.6);
  cont.innerHTML = hojas.map(h =>
    '<div class="paper" style="width:' + (h.w * MM * k) + "px;height:" + (h.h * MM * k) + 'px">' +
    h.svg.replace("<svg ", '<svg style="width:100%;height:100%;display:block" ') + "</div>").join("");
  /* cuánto papel queda sin usar en la última hoja: es el dato que importa */
  const sobra = (PAPEL_SEL !== "EXACTO" && cap > 0)
    ? (cap - (svgs.length % cap || cap))
    : 0;
  $("#nota").innerHTML = svgs.length + " cartel(es) · " + hojas.length + " hoja(s) · tamaño real " +
    fmtCm(t.w) + " × " + fmtCm(t.h) + " cm" +
    (sobra > 0 ? ' · <b>sobran ' + sobra + " espacio(s) en la última hoja</b>" : "") +
    ".<br>En el diálogo de impresión: márgenes <b>Ninguno</b>, escala <b>100%</b> y <b>gráficos de fondo</b> activados.";
}
function salida(comoPDF) {
  const t = TPLS[TPL_SEL];
  const hojas = imponer(svgsParaImprimir(), t, PAPEL_SEL, APP.cfg);
  registrar(t, hojas.length);
  imprimir(hojas);
  if (comoPDF) toast("Elige «Guardar como PDF» en el destino de impresión");
}

/* ---------------- impresión a tamaño físico exacto ---------------- */
function imprimir(hojas) {
  const w = hojas[0].w, h = hojas[0].h;
  let st = document.getElementById("printStyle");
  if (!st) { st = document.createElement("style"); st.id = "printStyle"; document.head.appendChild(st); }
  st.textContent = "@page{size:" + w + "mm " + h + "mm;margin:0}#printRoot .sheet{width:" + w + "mm;height:" + h + "mm}";
  $("#printRoot").innerHTML = hojas.map(x =>
    '<div class="sheet">' + x.svg.replace("<svg ", '<svg width="' + x.w + 'mm" height="' + x.h + 'mm" ') + "</div>").join("");
  setTimeout(() => window.print(), 60);
}

/* ---------------- registro local mínimo (para auditoría) ---------------- */
function registrar(tpl, n) {
  APP.historial.unshift({
    fecha: new Date().toISOString(), tienda: APP.cfg.tienda, sku: SEL.sku,
    producto: SEL.nombre, precio: SEL.precio_vigente, plantilla: tpl.id, hojas: n
  });
  if (APP.historial.length > 300) APP.historial.length = 300;
}

/* ================================================================
   ARRANQUE
   ================================================================ */
let TIENDA = "dib", MODO = "general", TIENDAS = null;
function refrescar() { pintarChips(); buscar(); }

async function cargarTaxonomia() {
  const r = await api("taxonomia", { tienda: TIENDA, modo: MODO }, { ttl: 6 * 3600000 });
  if (r.niveles && r.niveles.length) NIVELES = r.niveles;
  RUTAS = r.rutas || [];
}
async function init() {
  const url = new URL(location.href);
  try { TIENDAS = await (await fetch("config/tiendas.json", { cache: "no-store" })).json(); }
  catch (e) { pintarEstado("No se pudo leer config/tiendas.json", true); return; }
  TIENDA = url.searchParams.get("tienda") || localStorage.getItem("tienda") || Object.keys(TIENDAS.tiendas)[0];
  if (!TIENDAS.tiendas[TIENDA]) TIENDA = Object.keys(TIENDAS.tiendas)[0];
  MODO = url.searchParams.get("modo") || "general";
  if (!TIENDAS.modos[MODO]) MODO = "general";
  try { localStorage.setItem("tienda", TIENDA); } catch (e) {}

  const T = TIENDAS.tiendas[TIENDA], M = TIENDAS.modos[MODO];
  document.documentElement.style.setProperty("--acento", M.acento || T.acento);
  document.title = "Cartelería " + T.nombre + " · " + M.titulo;
  $("#sub").textContent = MODO === "descartados"
    ? "Productos que el generador normal deja fuera — revisa el motivo antes de imprimir"
    : "Busca el producto e imprime su cartel — precios en línea desde el ERP";
  $("#lblLista").textContent = "Buscar producto · " + T.nombre;
  APP.cfg.empresa = "DIB";
  APP.cfg.tienda = T.nombre;
  APP.cfg.tachar = true;
  if (T.redondeo) APP.cfg.redondeo = T.redondeo;

  const sel = $("#selTienda");
  Object.keys(TIENDAS.tiendas).forEach(k => (TIENDAS.tiendas[k].modos || ["general"]).forEach(mo => {
    const o = document.createElement("option");
    o.value = k + "|" + mo; o.textContent = TIENDAS.tiendas[k].nombre + " · " + TIENDAS.modos[mo].titulo;
    o.selected = (k === TIENDA && mo === MODO);
    sel.appendChild(o);
  }));
  sel.onchange = () => { const v = sel.value.split("|"); location.search = "?tienda=" + v[0] + "&modo=" + v[1]; };

  pintarEstado("Conectando…");
  try {
    const h = await api("health", {}, { ttl: 0 });
    pintarEstado("Backend v" + h.version + (h.mock ? " · DATOS SIMULADOS" : " · en línea"));
    await cargarTaxonomia();
  } catch (e) { pintarEstado("Sin conexión: " + e.message, true); }
  refrescar();

  $("#res").addEventListener("click", e => {
    const add = e.target.closest(".add");
    if (add) {
      e.stopPropagation();
      const g = RESULTADOS[+add.dataset.add];
      if (g) toggleBandeja(g.nombre).then(repintarMarcas);
      return;
    }
    const c = e.target.closest(".pcard");
    if (c) abrirHoja(c.dataset.g);
  });
  $("#q").oninput = () => { clearTimeout(window._t); window._t = setTimeout(buscar, 350); };
  $("#clr").onclick = () => { $("#q").value = ""; buscar(); $("#q").focus(); };
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { if ($("#panel").innerHTML) cerrarHoja(); else { $("#q").value = ""; buscar(); } }
    if (e.key === "/" && document.activeElement !== $("#q")) { e.preventDefault(); $("#q").focus(); }
    if (e.key === "Enter" && $("#panel").innerHTML && !e.target.closest("select")) {
      const b = $("#imprimir"); if (b && !b.disabled) b.click();
    }
  });
  window.addEventListener("resize", () => { if ($("#panel").innerHTML) pintarPreview(); });
}
init();

