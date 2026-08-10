# AVJ PLAY — reproductor web de canales TDT (IPTV)

Frontend estático (`index.html`, sin build) + backend opcional en
Node/Express (`server.js`) para buscar, categorizar y reproducir en
directo canales de TV, con soporte de fábrica para el catálogo público
de **TDTChannels**.

## Estructura del proyecto

```
index.html      → la web (frontend, un solo archivo)
server.js       → backend Node/Express: catálogo con caché + proxy
package.json    → dependencias y script "start" para Render
README.md       → este archivo
```

## Frontend — uso rápido

1. Abre `index.html` en cualquier navegador moderno.
2. Al cargar, intenta sintonizar automáticamente la lista oficial de TV
   de TDTChannels.
3. Usa el buscador y la tira de categorías ("sintonizador") para filtrar.
4. Haz clic en cualquier canal para reproducirlo en el panel lateral.
5. Pestañas **Películas** y **Series**: TDTChannels sólo distribuye TV
   en directo, así que empiezan vacías — puedes añadir tu propia lista
   M3U (URL o archivo) desde el botón que aparece.

El frontend funciona por sí solo (sin backend), apoyándose en proxies
CORS públicos de respaldo si hace falta. El backend de este repo es la
opción recomendada para producción: evita depender de terceros y añade
el catálogo con caché.

---

## Backend — endpoints

### `GET /health`
Comprobación de salud, usada por Render y por monitorización externa.

```json
{ "status": "ok" }
```

### `GET /api/channels`
Devuelve el catálogo de canales de TDTChannels ya **normalizado y
cacheado en memoria**, para que el frontend no tenga que descargar ni
procesar el JSON completo de TDTChannels en cada visita.

Cada canal se reduce a los campos que necesita el frontend:

```json
{
  "id": "la1-tv",
  "name": "La 1",
  "logo": "https://...",
  "web": "https://www.rtve.es/play/videos/directo/la-1/",
  "epg_id": "La1.TV",
  "group": "Generalistas",
  "country": "Spain",
  "streams": [
    { "format": "m3u8", "url": "https://...", "res": null, "lang": null, "geo": null }
  ],
  "extra_info": ["GEO"]
}
```

Respuesta completa del endpoint:

```json
{
  "source": "https://www.tdtchannels.com/lists/tv.json",
  "count": 350,
  "cached": true,
  "stale": false,
  "cached_at": "2026-08-10T18:00:00.000Z",
  "ttl_minutes": 10,
  "channels": [ /* ... */ ]
}
```

Comportamiento de la caché:

- **Caché vigente** (dentro del TTL): se sirve directamente, sin volver
  a descargar el JSON de TDTChannels para cada usuario.
- **Caché caducada o inexistente**: se intenta descargar y normalizar
  de nuevo. Las peticiones concurrentes durante esa descarga comparten
  la misma petición en curso (no se dispara una descarga por usuario).
- **La fuente falla pero hay caché anterior** (aunque esté caducada):
  se devuelve esa caché con `"stale": true` y un campo `"warning"`,
  en vez de un error.
- **La fuente falla y no hay ninguna caché todavía**: responde
  `502` con un JSON de error claro (`error`, `source`, `details`).

No se guarda ningún vídeo ni se usa base de datos: todo vive en
memoria del proceso y se pierde/reconstruye si el servidor se reinicia.

### `GET /proxy?url=<URL_CODIFICADA>`
Proxy CORS para listas M3U/M3U8 y streams. Si la URL es una playlist
`.m3u`/`.m3u8`, reescribe las rutas internas para que también pasen por
el proxy (necesario para reproducir HLS con segmentos externos).

**Restringido por lista blanca de dominios** (`ALLOWED_PROXY_HOSTS`,
ver variables de entorno abajo) para no operar como un proxy abierto
en producción. Si la URL pedida no pertenece a un dominio permitido,
responde `403` con un JSON de error.

---

## Variables de entorno

| Variable              | Obligatoria | Por defecto                                  | Descripción |
|-----------------------|:-----------:|-----------------------------------------------|-------------|
| `PORT`                | No          | `8787`                                         | Puerto de escucha. Render la inyecta automáticamente. |
| `CATALOG_SOURCE_URL`  | No          | `https://www.tdtchannels.com/lists/tv.json`    | Fuente del catálogo para `/api/channels`. |
| `CACHE_TTL_MINUTES`   | No          | `10`                                           | Minutos que se conserva el catálogo en caché antes de refrescarlo. |
| `ALLOWED_PROXY_HOSTS` | Recomendada en producción | *(vacío = proxy abierto)*        | Dominios permitidos en `/proxy`, separados por comas. Un dominio en la lista también permite sus subdominios (`rtve.es` permite `ztnr.rtve.es`). |

Ejemplo para Render (una variable por línea, en la sección
**Environment** del servicio):

```
CACHE_TTL_MINUTES=10
ALLOWED_PROXY_HOSTS=www.tdtchannels.com,rtve.es,mitele.es,3catdirectes.cat
```

Si no defines `ALLOWED_PROXY_HOSTS`, el proxy acepta cualquier dominio
(el servidor avisa de esto por consola al arrancar). Ténlo en cuenta:
en un despliegue público conviene fijar la lista según los dominios de
streaming que realmente uses, ya que los canales de TDTChannels vienen
de decenas de emisoras distintas.

---

## Desplegar en Render

El proyecto incluye `package.json` con las únicas dependencias que usa
`server.js` (`express`, `cors`, `node-fetch@2`), sin base de datos ni
servicios externos (nada de Supabase/Firebase).

Al crear un **Web Service** en Render apuntando a este repo:

- **Build Command:** `npm install`
- **Start Command:** `npm start`

Render inyecta automáticamente `PORT`; `server.js` ya la lee
(`process.env.PORT`) y escucha en `0.0.0.0`, que es lo que Render
requiere para detectar el puerto abierto. No hace falta configurar
nada más para que arranque — añade `ALLOWED_PROXY_HOSTS` en
**Environment** cuando quieras restringir el proxy.

Una vez desplegado:

```bash
curl https://tu-servicio.onrender.com/health
curl https://tu-servicio.onrender.com/api/channels
```

## Uso local del backend

```bash
npm install
npm start
# escucha en http://localhost:8787
```

En `index.html` puedes apuntar las URLs de listas/streams a tu backend:

```
http://localhost:8787/api/channels
http://localhost:8787/proxy?url=<URL_ORIGINAL_CODIFICADA_EN_URI>
```

## Formatos soportados por el frontend

- **M3U / M3U8**: parseado nativo, incluye `tvg-logo`, `group-title`, `tvg-id`.
- **JSON**: intenta reconocer estructuras comunes (`channels`, `list`,
  `items`, o array plano con `name`/`url`/`logo`/`group`), y el formato
  normalizado que devuelve `/api/channels`.
- **Enigma2**: no aplica a un reproductor web (es un formato para
  decodificadores físicos como Dreambox/Vu+), así que no se incluye aquí.

## Nota legal

Esta aplicación **no aloja, transcodifica ni redistribuye** ningún
contenido, y **no almacena vídeo** en ningún momento: el backend sólo
reenvía (proxy) y cachea metadatos de texto (nombres, logos, URLs).
Por defecto usa el catálogo público de TDTChannels, que según su
propia documentación proviene de las fuentes oficiales de cada cadena.
Si añades listas propias para películas o series, es tu responsabilidad
asegurarte de que provienen de fuentes legales.
