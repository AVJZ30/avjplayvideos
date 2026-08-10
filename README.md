# ANTENA — reproductor web de canales TDT (IPTV)

Web estática (un solo archivo `index.html`, sin instalación) para buscar,
categorizar y reproducir en directo listas M3U/M3U8, con soporte para
las listas oficiales de **TDTChannels** de fábrica.

## Uso rápido

1. Abre `index.html` en cualquier navegador moderno (Chrome, Firefox, Safari, Edge).
2. Al cargar, intenta sintonizar automáticamente la lista oficial de TV
   (`https://www.tdtchannels.com/lists/tv.m3u8`).
3. Usa el buscador y la tira de categorías ("sintonizador") para filtrar canales.
4. Haz clic en cualquier canal para reproducirlo en el panel lateral.
5. Pestañas **Películas** y **Series**: TDTChannels sólo distribuye TV en
   directo, así que estas secciones empiezan vacías. Puedes añadir tu propia
   lista M3U (URL o archivo) desde el botón que aparece — asegúrate de que
   la fuente sea legal.

## Sobre el CORS (por qué a veces falla la carga automática)

Los navegadores bloquean peticiones `fetch()` a otros dominios si ese
dominio no habilita CORS explícitamente. La web ya intenta, en este orden:

1. Petición directa a la URL.
2. Dos proxies CORS públicos de respaldo (`allorigins.win`, `corsproxy.io`).
3. Si todo falla, te deja subir el archivo `.m3u`/`.m3u8` descargado a mano
   (esto siempre funciona, porque no depende de red).

Los proxies públicos son gratuitos pero **no fiables al 100%** (pueden caer
o tener límites de uso). Para un despliegue serio, usa el proxy propio
incluido en `server.js`.

## "Banco de render" — proxy propio (opcional, backend)

`server.js` es un pequeño servidor Node/Express que reenvía las listas y
los segmentos de vídeo, evitando por completo los bloqueos de CORS y las
dependencias de proxies de terceros.

```bash
npm install express node-fetch@2 cors
node server.js
# escucha en http://localhost:8787
```

Para usarlo, en `index.html` sustituye las URLs de listas/streams por:

```
http://localhost:8787/proxy?url=<URL_ORIGINAL_CODIFICADA_EN_URI>
```

Esto es opcional — la web funciona igual sin él, apoyándose en los
proxies públicos como respaldo.

## Desplegar el proxy en Render

El proyecto incluye `package.json` con las únicas dependencias que usa
`server.js` (`express`, `cors`, `node-fetch@2`), sin base de datos ni
servicios externos (nada de Supabase/Firebase).

En Render, al crear un **Web Service** apuntando a este repo:

- **Build Command:** `npm install`
- **Start Command:** `npm start`

Render inyecta automáticamente la variable de entorno `PORT`; `server.js`
ya la lee (`process.env.PORT`) y escucha en `0.0.0.0`, que es lo que Render
requiere para detectar el puerto abierto. No hace falta configurar nada
más. Una vez desplegado, prueba `https://tu-servicio.onrender.com/` — debe
responder "ANTENA proxy activo…".

## Formatos soportados

- **M3U / M3U8**: parseado nativo, incluye `tvg-logo`, `group-title`, `tvg-id`.
- **JSON**: intenta reconocer estructuras comunes (`channels`, `list`,
  `items`, o array plano con `name`/`url`/`logo`/`group`).
- **Enigma2**: no aplica a un reproductor web (es un formato para
  decodificadores físicos como Dreambox/Vu+), así que no se incluye aquí.

## Nota legal

Esta aplicación **no aloja, transcodifica ni redistribuye** ningún
contenido: es únicamente un reproductor que apunta a las URLs de las
listas que tú elijas cargar. Por defecto usa las listas oficiales de
TDTChannels, que según su propia documentación provienen de las fuentes
oficiales de cada cadena. Si añades listas propias para películas o
series, es tu responsabilidad asegurarte de que provienen de fuentes
legales.
