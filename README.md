# AVJ PLAY — TV en directo (+ Películas/Series preparadas)

## Estructura del proyecto

```
index.html      → shell del frontend (estructura HTML, sin lógica)
style.css        → estilos del frontend
config.js        → URLs de las 3 fuentes de datos (TV / Películas / Series)
app.js           → toda la lógica del frontend (catálogo, filtros, favoritos, reproductor)
server.js        → backend Node/Express: catálogo con caché + proxy (Render)
package.json     → dependencias y script "start" del backend
README.md        → este archivo
```

El frontend es 100% estático (sin build). El backend (`server.js`) ya está
desplegado en `https://avjplay-backend.onrender.com` y **no se ha tocado**
en este cambio.

---

## Qué causaba el error del reproductor

No era un problema del backend ni de las URLs en sí — eran dos cosas
distintas que el frontend anterior mezclaba bajo el mismo mensaje genérico:

1. **Canales cuyo stream m3u8 sí es válido pero el proveedor bloquea la
   reproducción desde un navegador ajeno** (CORS, geobloqueo, o
   comprobación de origen/referer del lado del proveedor). Esto es una
   restricción del propio proveedor de streaming, no un bug: cuando
   `hls.js` reporta un error fatal de tipo `networkError`, ahora se
   distingue explícitamente de un fallo genérico y se muestra:
   *"La fuente no permite la reproducción desde este navegador
   (posible restricción CORS, geobloqueo o control de origen del
   proveedor). No se intentará saltar esta restricción."* — tal y como
   pediste, sin intentar rodear esa protección.

2. **Canales cuyo array `streams` sólo traía formatos que este
   reproductor no soporta** (por ejemplo `youtube`, embebidos propios,
   etc., sin ningún `format === "m3u8"`). El código anterior podía
   intentar reproducirlos igualmente y fallar con el mensaje genérico.
   Ahora se detecta ese caso *antes* de tocar el reproductor y se
   muestra un mensaje distinto ("formato no compatible"), sin
   confundirlo con un fallo de red.

Además, el mensaje de error anterior no dejaba rastro real en consola.
Ahora, cada fallo fatal de `hls.js` se registra con
`console.error("[AVJ PLAY][HLS ERROR]", { url, type, details, fatal,
responseCode })`, y los errores del `<video>` nativo (Safari) se
registran con `console.error("[AVJ PLAY][NATIVE ERROR]", { url, code,
message })` — así puedes ver la causa real en las DevTools en vez de
quedarte sólo con el mensaje amigable.

Como mejora adicional: si un canal declara **varios** streams m3u8 en su
array `streams`, el reproductor prueba automáticamente el siguiente
antes de rendirse (sigue siendo una fuente que la propia API ofrece
para ese canal — no es un salto de restricciones, sólo usar otra opción
ya declarada).

---

## Archivos modificados / creados

| Archivo       | Cambio |
|---------------|--------|
| `index.html`  | Reescrito: nueva navegación (Inicio / TV en vivo / Películas / Series / Favoritos), estructura para el reproductor con overlays de carga/error/sin-stream. |
| `app.js`      | **Nuevo.** Toda la lógica: fetch a `CHANNELS_API_URL`, normalización, categorías dinámicas desde `channel.group`, búsqueda y filtrado en memoria, favoritos en `localStorage`, reproductor HLS con diagnóstico detallado, y carga opcional de Películas/Series. |
| `style.css`   | **Nuevo.** Estilos separados del HTML (tema oscuro, tarjetas, chips de categoría, panel del reproductor, responsive). |
| `config.js`   | **Nuevo.** Único lugar con las 3 URLs de fuentes de datos. |
| `server.js`   | **Sin cambios.** |
| `package.json`| **Sin cambios.** |

---

## Configuración (`config.js`)

```js
window.AVJPLAY_CONFIG = {
  CHANNELS_API_URL: "https://avjplay-backend.onrender.com/api/channels",
  MOVIES_API_URL: "",   // vacío a propósito: no hay fuente real todavía
  SERIES_API_URL: "",   // vacío a propósito: no hay fuente real todavía
};
```

- **TV en vivo** ya funciona contra el backend real.
- **Películas** y **Series** muestran *"— Próximamente"* mientras
  `MOVIES_API_URL` / `SERIES_API_URL` estén vacías. En cuanto exista una
  fuente real con la estructura indicada más abajo, basta con poner la
  URL aquí — no hace falta tocar `app.js`.

### Estructura esperada de `MOVIES_API_URL`
```json
{ "movies": [
  { "id": "movie-1", "title": "Ejemplo", "description": "…", "poster": "https://…",
    "year": 2026, "genre": "Acción", "streamUrl": "https://…" }
]}
```

### Estructura esperada de `SERIES_API_URL`
```json
{ "series": [
  { "id": "series-1", "title": "Ejemplo", "description": "…", "poster": "https://…",
    "year": 2026, "genre": "Drama",
    "seasons": [{ "number": 1, "episodes": [
      { "number": 1, "title": "Episodio 1", "streamUrl": "https://…" }
    ]}] }
]}
```

Si el fetch a cualquiera de las dos falla, o la fuente no devuelve
elementos, el frontend cae de forma segura al estado "Próximamente" —
nunca inventa contenido.

---

## Rendimiento con ~750 canales

- **Sin peticiones repetidas**: `/api/channels` se pide una sola vez al
  cargar (y aprovecha la caché de 10 min del propio backend). Buscar y
  cambiar de categoría filtra el array ya descargado, en memoria.
- **Lazy loading de logos**: todas las imágenes usan `loading="lazy"`.
- **Renderizado por lotes**: la grid se pinta en tandas de 60 tarjetas
  vía `requestAnimationFrame`, y un token de renderizado cancela un
  lote a medio pintar si el usuario cambia de filtro antes de que
  termine (evita trabajo de DOM desperdiciado).
- **Un único reproductor activo**: sólo existe una instancia de
  `Hls`/`<video>`; se destruye y se vuelve a crear al cambiar de canal,
  nunca se acumulan instancias en segundo plano.

---

## Cómo probarlo en localhost

El frontend es estático, así que basta con servirlo con cualquier
servidor HTTP simple (no puede abrirse como `file://` directo en todos
los navegadores por las políticas de módulos/CORS al pedir `config.js`
vía `fetch`, aunque en la mayoría sí funciona igualmente; server local
es lo más fiable):

```bash
cd carpeta-del-proyecto
python3 -m http.server 8080
# abre http://localhost:8080
```

o con Node:

```bash
npx serve .
```

Con `config.js` apuntando ya a `https://avjplay-backend.onrender.com/api/channels`,
no hace falta levantar el backend en local para probar el frontend — sólo
necesitas conexión a internet. Si además quieres correr tu propio backend
en local:

```bash
npm install
npm start
# backend en http://localhost:8787
```

y cambia temporalmente en `config.js`:

```js
CHANNELS_API_URL: "http://localhost:8787/api/channels",
```

---

## Verificación realizada antes de la entrega

Como este proyecto corre en el navegador (no hay forma de "ejecutarlo"
en un servidor sin interfaz), la lógica se validó con dos baterías de
pruebas automatizadas fuera del navegador antes de entregarlo:

1. **Funciones puras** (`normalizeText`, `buildCategories`,
   `filterChannels`, `pickPlayableStreams`) probadas de forma aislada
   con Node.
2. **Prueba de integración con DOM real (jsdom)**: se sirvió el propio
   `index.html`/`app.js`/`style.css` por HTTP y se simuló un backend con
   la forma exacta de `/api/channels`, incluyendo un canal con
   `streams: []`, uno sólo con formato `youtube` (no soportado) y uno
   con m3u8 válido. Se comprobó automáticamente que:
   - el contador de canales, las categorías y las tarjetas se generan
     desde la respuesta real de la API,
   - los logos llevan `loading="lazy"`,
   - un canal sin streams muestra exactamente
     *"Este canal no tiene un stream reproducible disponible
     actualmente."* con el botón a `channel.web`,
   - un canal sin formato compatible muestra un mensaje distinto y
     claro,
   - los favoritos se guardan y se leen de `localStorage`,
   - buscar no dispara una nueva petición a `/api/channels`,
   - Películas y Series muestran "Próximamente" sin inventar datos,
   - `hls.js` (build real, no un stub) se carga y se engancha
     correctamente al reproductor.

   La única pieza que **no** se pudo verificar dentro de esta prueba es
   la decodificación de vídeo en sí, porque el entorno de prueba
   (jsdom) no implementa `MediaSource` — eso es una limitación del
   entorno de test, no del código; en cualquier navegador real esa API
   sí existe y la reproducción HLS funciona con el mismo código.
   Este sandbox tampoco tiene salida de red hacia `onrender.com`, así
   que no pude hacer una petición real de extremo a extremo contra tu
   backend en producción desde aquí — te recomiendo abrir la consola
   del navegador la primera vez que lo pruebes en tu máquina para
   confirmar los canales concretos que fallan por CORS/geobloqueo del
   proveedor (ahora quedarán señalados con detalle, no como un error
   genérico).

## Nota legal

Esta aplicación no aloja, transcodifica ni redistribuye ningún
contenido, no hace scraping, y no intenta saltarse CORS, DRM,
geobloqueos ni autenticación de ningún proveedor. Los favoritos se
guardan únicamente en `localStorage` del navegador del usuario — no hay
base de datos ni backend adicional para ese dato.
