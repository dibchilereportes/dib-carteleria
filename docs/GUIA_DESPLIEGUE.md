# Guía de despliegue paso a paso — Cartelería DIB

Tiempo total estimado: **1 hora** hasta tener la app corriendo en internet con datos simulados. Conectar el ERP real es un paso más al final.

Lo que tienes en esta carpeta ya está probado: el backend responde a las 5 acciones, el frontend busca, abre fichas e imprime un cartel. No hay que escribir código para llegar a la URL pública.

Necesitas: una cuenta Google (la misma que usa tus otros proyectos de Apps Script), una cuenta GitHub, y un PC con Windows.

---

## PARTE 1 — Backend en Google Apps Script (20 min)

### 1.1 Crear el proyecto

1. Abre https://script.google.com en el navegador, logueado con la cuenta Google correcta.
2. Botón **+ Nuevo proyecto** (arriba a la izquierda).
3. Arriba, donde dice "Proyecto sin título", haz clic y ponle `carteleria-api` → Enter.

### 1.2 Cargar los archivos

**Opción rápida (recomendada):** abre `backend/TODO_EN_UNO.gs`, Ctrl+A, Ctrl+C, y pégalo reemplazando todo el contenido de `Código.gs`. Ctrl+S. Salta al 1.3. (Es la unión de los 7 archivos; no necesitas crear ninguno más.)

**Opción por archivos (si prefieres tenerlos separados):**

El editor abre con un archivo `Código.gs` con una función vacía. Vas a crear 7 archivos y pegar en cada uno el contenido de `backend/`.

4. Abre `backend/Code.gs` de esta carpeta con el Bloc de notas / VS Code, **Ctrl+A, Ctrl+C**.
5. En el editor de Apps Script, haz clic dentro de `Código.gs`, **Ctrl+A, Ctrl+V** (reemplaza todo).
6. En el panel izquierdo "Archivos", clic en **+** → **Secuencia de comandos** → escribe `validar` → Enter. Se crea `validar.gs`. Pega el contenido de `backend/validar.gs`.
7. Repite el paso 6 para: `erp`, `mapear`, `handlers`, `cache`, `mock`. (6 archivos nuevos + el `Código.gs` original = 7).
8. **Ctrl+S** para guardar (o el icono de disquete).

### 1.3 Manifiesto (zona horaria y permisos de la Web App)

9. Panel izquierdo, icono de engranaje ⚙️ **Configuración del proyecto**.
10. Marca la casilla **"Mostrar el archivo de manifiesto appsscript.json en el editor"**.
11. Vuelve al editor `< >` → ahora aparece `appsscript.json`. Ábrelo y reemplaza todo con el contenido de `backend/appsscript.json`. Guarda.

### 1.4 Propiedades del script (aquí viven los secretos)

12. ⚙️ **Configuración del proyecto** → baja hasta **Propiedades del script** → **Añadir propiedad del script**.
13. Agrega una por una (Propiedad / Valor):

| Propiedad | Valor | Notas |
|---|---|---|
| `ERP_MOCK` | `1` | Datos simulados. Cuando conectes el ERP cámbialo a `0`. |
| `APP_TOKEN` | un texto aleatorio largo | Genera uno en PowerShell: `-join ((48..57)+(97..122) \| Get-Random -Count 40 \| % {[char]$_})`. Guárdalo, lo necesitas en GitHub. |
| `ERP_URL` | `https://tu-erp.cl` | Déjalo vacío por ahora si no lo tienes. |
| `ERP_API_KEY` | la clave del ERP | Déjalo vacío por ahora. |

14. **Guardar propiedades del script**.

### 1.5 Publicar la Web App

15. Arriba a la derecha, botón azul **Implementar** → **Nueva implementación**.
16. Junto a "Seleccionar tipo", clic en el engranaje ⚙️ → **Aplicación web**.
17. Rellena:
    - Descripción: `v1`
    - Ejecutar como: **Yo (tu correo)**
    - Quién tiene acceso: **Cualquier usuario**  ← importante; si dice "Cualquier usuario con cuenta de Google" las tiendas no podrán entrar sin loguearse.
18. **Implementar**.
19. Aparece "Autorizar acceso" → **Autorizar acceso** → elige tu cuenta → si sale "Google no ha verificado esta aplicación": **Configuración avanzada** → **Ir a carteleria-api (no seguro)** → **Permitir**.
20. Se muestra la **URL de la aplicación web**: `https://script.google.com/macros/s/AKfycb…/exec`. Botón **Copiar**. Esta es tu `GAS_URL`. Pégala en un bloc de notas junto al `APP_TOKEN`.

### 1.6 Probar el backend (antes de seguir)

21. En el navegador abre (reemplaza `GAS_URL` y `TOKEN`):

```
GAS_URL?action=health&t=TOKEN
```
Debe mostrar `{"ok":true,"version":"1.0.0","hora":"…","mock":true}`.

22. Prueba una búsqueda:

```
GAS_URL?action=buscar&tienda=dib&q=plumon&t=TOKEN
```
Debe mostrar `"grupos":[{"nombre":"PLUMON TODA ESTACION",…`

23. Prueba que rechaza listados sin filtro:

```
GAS_URL?action=buscar&tienda=dib&t=TOKEN
```
Debe mostrar `"code":"CONSULTA_VACIA"`.

24. Prueba que rechaza sin token:

```
GAS_URL?action=health
```
Debe mostrar `"code":"NO_AUTORIZADO"`.

Si algo falla: panel izquierdo **Ejecuciones** (icono de lista) muestra cada llamada con su error real.

> **Cada vez que edites el backend** a futuro: Implementar → **Administrar implementaciones** → lápiz ✏️ → Versión: **Nueva versión** → Implementar. Así la URL se mantiene. Si haces "Nueva implementación", la URL cambia y tendrás que actualizarla en GitHub (Parte 3, paso 40).

---

## PARTE 2 — Subir el repositorio a GitHub (15 min)

### 2.1 Instalar herramientas (una sola vez)

25. Abre **PowerShell** (Inicio → escribe PowerShell → Enter) y ejecuta:

```powershell
winget install --id Git.Git -e
winget install --id GitHub.cli -e
```
Cierra y vuelve a abrir PowerShell para que reconozca `git` y `gh`.

26. Configura tu identidad y loguea GitHub:

```powershell
git config --global user.name "Felipe Dib"
git config --global user.email "felipedibgorke@gmail.com"
gh auth login
```
En `gh auth login` responde: **GitHub.com** → **HTTPS** → **Yes** (authenticate Git) → **Login with a web browser** → copia el código, Enter, pégalo en el navegador → **Authorize**.

### 2.2 Preparar la carpeta

27. Descomprime `dib-carteleria.zip` en, por ejemplo, `C:\Proyectos\dib-carteleria`.
28. Verifica que **no exista** `config/app.json` (solo debe estar `config/app.json.example`). Si existe, bórralo: es un archivo local que se genera en el deploy.
29. En PowerShell:

```powershell
cd C:\Proyectos\dib-carteleria
git init -b main
git add .
git status
```
`git status` debe listar `index.html`, `src/…`, `backend/…`, `config/tiendas.json`, `.github/workflows/pages.yml`, etc., y **no** debe listar `config/app.json`. Si aparece, revisa que `.gitignore` esté en la raíz.

30. Verificación de seguridad (que no viaje ninguna clave):

```powershell
git grep -il "AKfycb" ; git grep -il "api_key" ; git grep -il "apikey"
```
Solo debe aparecer `config/app.json.example` y los `.md` de `docs/` (son ejemplos). Si aparece otro archivo, revísalo antes de seguir.

31. Primer commit:

```powershell
git commit -m "Cartelería única: frontend, backend GAS, config y docs"
```

### 2.3 Crear el repo en GitHub y subir

32. Con GitHub CLI (crea el repo remoto y sube en un solo comando):

```powershell
gh repo create dib-carteleria --public --source=. --push
```
Responde las preguntas con Enter (valores por defecto). Al terminar muestra `https://github.com/TUUSUARIO/dib-carteleria`.

**Debe ser público**: GitHub Pages gratis solo funciona con repos públicos. No hay problema porque el repo no contiene claves; el único dato "expuesto" es la `GAS_URL`, que está protegida por el token, los límites y el rate limit del backend.

*Alternativa sin CLI:* en github.com → **+** → **New repository** → nombre `dib-carteleria`, **Public**, sin README → **Create repository**. Luego en PowerShell:
```powershell
git remote add origin https://github.com/TUUSUARIO/dib-carteleria.git
git push -u origin main
```

---

## PARTE 3 — Activar GitHub Pages (10 min)

### 3.1 Variables del deploy

33. En el navegador: `https://github.com/TUUSUARIO/dib-carteleria` → pestaña **Settings** (arriba a la derecha).
34. Menú izquierdo → **Secrets and variables** → **Actions**.
35. Pestaña **Variables** (no "Secrets") → **New repository variable**:
    - Name: `GAS_URL` · Value: la URL del paso 20 → **Add variable**.
36. Otra vez **New repository variable**:
    - Name: `APP_TOKEN` · Value: el token del paso 13 → **Add variable**.

### 3.2 Fuente de Pages

37. Menú izquierdo → **Pages**.
38. En **Build and deployment → Source**, elige **GitHub Actions** (no "Deploy from a branch").

### 3.3 Ejecutar el deploy

39. Pestaña **Actions** (arriba). Verás el workflow **Deploy Pages**. Si está en rojo ✗ (corrió antes de que existieran las variables), ábrelo → **Re-run all jobs**. Si no corrió, menú izquierdo → **Deploy Pages** → **Run workflow** → **Run workflow**.
40. Espera ~1 minuto. Cuando esté verde ✓, abre el job `deploy`: al final muestra la URL:

```
https://TUUSUARIO.github.io/dib-carteleria/
```

### 3.4 Comprobar

41. Abre `https://TUUSUARIO.github.io/dib-carteleria/config/app.json` → debe mostrar tu `gasUrl` y `token` reales. Si `gasUrl` está vacío, la variable está mal escrita (mayúsculas exactas: `GAS_URL`).
42. Abre `https://TUUSUARIO.github.io/dib-carteleria/?tienda=sur` → en la cabecera debe decir **"Backend v1.0.0 · DATOS SIMULADOS · build xxxxxxx"**.
43. Escribe `plumon` → aparece la tarjeta → clic → tabla de variantes → **Cartel** → **Imprimir** → en el diálogo elige "Guardar como PDF" y comprueba que el cartel mide 130×180 mm.
44. Prueba `?tienda=sur&modo=descartados` → chip **HOTELERIA** → aparece la toalla con motivo "LINEA EXCLUIDA".

**Listo: la app está corriendo en internet.** Cada `git push` a `main` vuelve a publicar solo.

---

## PARTE 4 — Conectar el ERP real (30–60 min, depende de tu API)

Aquí sí hay que tocar código, pero solo **un archivo**: `backend/erp.gs`.

45. Abre el proyecto de Apps Script que **ya funciona** con el ERP y copia de ahí: la URL base, cómo manda la API key (header `Authorization: Bearer`, `X-API-Key`, o dentro del body), el endpoint de búsqueda de productos y los nombres reales de los campos.
46. En `erp.gs` ajusta:
    - `erpFetch_`: la línea `headers: { 'Authorization': 'Bearer ' + cfg.key }` → el esquema real.
    - `erpBuscarProductos_`, `erpProductosPorGrupo_`, `erpProductoPorSku_`, `erpProductosPorSkus_`, `erpTaxonomia_`: el `path` y el formato del `payload` que espera tu API.
    - `CAMPOS_ERP`: nombres reales (`x_linea`, `x_familia`, `list_price`… son de ejemplo). Los mismos nombres deben usarse en `aProducto_` de `mapear.gs`.
    - `CONFIG_TIENDAS` en `validar.gs`: el `pricelist_id` real de cada lista de precios.
47. Pega el `erp.gs` (y `mapear.gs`/`validar.gs` si los tocaste) en el editor de Apps Script → Guardar.
48. Prueba **sin publicar** desde el editor: abre `handlers.gs`, arriba elige la función `hBuscar_`… no acepta parámetros desde el editor, así que crea temporalmente al final de `Code.gs`:

```javascript
function pruebaLocal() {
  PropertiesService.getScriptProperties().setProperty('ERP_MOCK', '0');
  Logger.log(JSON.stringify(hBuscar_({ tienda: 'dib', modo: 'general', q: 'roller', linea: '', familia: '', subfamilia: '', motivo: '', limit: 10, pagina: 1 })));
}
```
Selecciona `pruebaLocal` en el desplegable de arriba → **Ejecutar** → autoriza (ahora pide permiso para "conectarse a un servicio externo") → **Registro de ejecución** muestra el JSON. Si sale `ERP_ERROR`/`ERP_TIMEOUT`, el registro dice el HTTP real.
49. Cuando funcione: ⚙️ Propiedades → `ERP_MOCK` = `0`, rellena `ERP_URL` y `ERP_API_KEY`. Borra `pruebaLocal`. Opcional: borra `mock.gs`.
50. **Implementar → Administrar implementaciones → ✏️ → Nueva versión → Implementar.**
51. Recarga la app en Pages: la cabecera ya no dice "DATOS SIMULADOS". Compara 20 SKUs contra el HTML antiguo del mismo día.

---

## PARTE 5 — Portar las 6 plantillas reales (2–3 días, trabajo de desarrollo)

El scaffold imprime un cartel genérico de 130×180. Para reemplazarlo por `ALF_9X11`, `ALF_65X9`, `MUEBLES_8X5`, `TEX_LIM_NORMAL`, `TEX_LIM_PROMO`, `ROLLER_13X18`:

52. Del HTML original (`carteleria_dib_6.html`) copia a `src/core/texto.js` las funciones `fitSize`, `anchoTexto`, `partirEnDos`; a `src/templates/_primitivas.js` las funciones `T`, `R`, `L`, `badgeOff`, `codigoSKU`, `pieLegal`, `bloquePPUM`, `envolver`, `kicker`; y a `src/print/` las funciones `PAPELES`, `imponer`, `marcasCorte`, `capacidadHoja`.
53. Cada entrada de `TPLS` del HTML pasa a un archivo `src/templates/<id>.js` que exporta `{ id, nombre, tipo, w, h, aplica, render }` (ejemplo en `docs/ARQUITECTURA_CARTELERIA.md`, sección 6.1).
54. En `src/app.js`, `cartelGenerico()` se reemplaza por `formatosPara(item)` + `TEMPLATES.get(id).render(ctx, cfg, P)`, y `previsualizar()` pasa a ofrecer los formatos permitidos + papel + copias (mismo flujo que la función `pintarHoja()` original).
55. Los `items` que devuelve el backend tienen los mismos nombres de campo que usaba `normalizarProducto()` en el HTML (`sku, nombre, descripcion, categoria, familia, subfamilia, precio_normal, precio_oferta, dto, outlet, descontinuado, stock, motivo, ppum_valor, ppum_unidad`), así que las plantillas se portan sin cambiar su cuerpo.

Cada avance: `git add . ; git commit -m "..." ; git push` → Pages se actualiza solo.

---

## PARTE 6 — Poner en tiendas

56. Genera un QR por tienda/modo (cualquier generador online) con las URLs:
    - `https://TUUSUARIO.github.io/dib-carteleria/?tienda=dib`
    - `https://TUUSUARIO.github.io/dib-carteleria/?tienda=dib&modo=descartados`
    - `https://TUUSUARIO.github.io/dib-carteleria/?tienda=sur`
    - `https://TUUSUARIO.github.io/dib-carteleria/?tienda=sur&modo=descartados`
57. La app recuerda la última tienda elegida en cada PC (`localStorage`), así que basta abrir la URL base una vez.
58. Una semana en paralelo con los HTML viejos; después reemplaza esos 4 archivos por uno que solo diga "Esta versión quedó obsoleta → nueva URL".
59. Tienda nueva: agrega una entrada en `config/tiendas.json` **y** en `CONFIG_TIENDAS` de `validar.gs` (con su `pricelist_id`), push + nueva versión del backend. Nada más.

---

## Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| Cabecera dice "Sin backend: config/app.json sin gasUrl" | La variable `GAS_URL` no existe o el workflow corrió antes de crearla → Actions → Re-run. |
| "Sin conexión con el servidor" (código RED) | La Web App no está publicada como "Cualquier usuario", o la URL termina en `/dev` en vez de `/exec`. |
| `NO_AUTORIZADO` | El `APP_TOKEN` de GitHub (Variables) no coincide con el de Propiedades del script. Copia y pega, sin espacios. |
| Editaste el backend y no cambia nada | Falta **Administrar implementaciones → Nueva versión**. Guardar no publica. |
| `ERP_TIMEOUT` siempre | `ERP_URL` sin `https://`, o el firewall del ERP bloquea las IPs de Google. Pide al proveedor del ERP permitir tráfico desde Google Apps Script. |
| Pages da 404 | Settings → Pages → Source debe ser **GitHub Actions**. Y el repo debe ser público. |
| El cartel no mide lo que debe | En el diálogo de impresión: escala **100 %**, márgenes **Ninguno**, desmarca "Ajustar a la página". |
| Muchas tiendas y lento | Sube la caché en `handlers.gs` (`conCache_(key, 120, …)` → 300) y revisa cuotas en el panel de Apps Script. |
