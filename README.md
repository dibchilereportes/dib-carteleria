# Cartelería DIB

App única de cartelería de precios para las tiendas DIB / Sur. Reemplaza a los 4 HTML con catálogo embebido.

- **Frontend**: `index.html` + `src/` (estático, GitHub Pages).
- **Backend**: `backend/` (Google Apps Script Web App, proxy hacia el ERP; la API key vive solo ahí).
- **Config**: `config/tiendas.json` (tiendas y modos), `config/formatos.json` (reglas de plantilla), `config/app.json` (generado en el deploy, no se commitea).

Uso: `https://<usuario>.github.io/dib-carteleria/?tienda=sur&modo=descartados`

Documentación: [docs/GUIA_DESPLIEGUE.md](docs/GUIA_DESPLIEGUE.md) (paso a paso) · [docs/ARQUITECTURA_CARTELERIA.md](docs/ARQUITECTURA_CARTELERIA.md) (diseño).
