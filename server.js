/**
 * AVJ PLAY — backend (Node + Express)
 * ------------------------------------------------------------------
 * Este servidor cumple dos funciones, ambas sin base de datos y sin
 * almacenar vídeo en ningún momento:
 *
 * 1. GET /api/channels
 *    Descarga el catálogo público de TDTChannels (tv.json), lo
 *    normaliza a un formato compacto pensado para el frontend, y lo
 *    sirve desde una caché en memoria (TTL configurable). Así el
 *    frontend nunca tiene que descargar ni parsear el JSON completo
 *    de TDTChannels en cada visita.
 *
 * 2. GET /proxy?url=<URL_CODIFICADA>
 *    Proxy CORS para listas M3U/M3U8 y streams, restringido por una
 *    lista blanca de dominios (ALLOWED_PROXY_HOSTS) para no operar
 *    como un proxy abierto en producción.
 *
 * 3. GET /health → { "status": "ok" }
 *
 * Uso local:
 *   npm install
 *   npm start
 *
 * En Render: ver package.json (script "start"). El puerto se toma de
 * la variable de entorno PORT que Render inyecta automáticamente.
 */
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

/* ------------------------------------------------------------------ */
/* Configuración por variables de entorno                              */
/* ------------------------------------------------------------------ */
const PORT = process.env.PORT || 8787;
const HOST = "0.0.0.0"; // Render requiere escuchar en 0.0.0.0, no en localhost

// Fuente del catálogo (por defecto, la lista pública oficial de TDTChannels).
const CATALOG_SOURCE_URL =
  process.env.CATALOG_SOURCE_URL || "https://www.tdtchannels.com/lists/tv.json";

// Minutos que se conserva el catálogo normalizado en memoria antes de
// volver a descargarlo. Configurable, por ejemplo CACHE_TTL_MINUTES=10.
const CACHE_TTL_MINUTES = Number(process.env.CACHE_TTL_MINUTES) > 0
  ? Number(process.env.CACHE_TTL_MINUTES)
  : 10;
const CACHE_TTL_MS = CACHE_TTL_MINUTES * 60 * 1000;

// Lista blanca de dominios permitidos para /proxy, separados por comas.
// Ejemplo: ALLOWED_PROXY_HOSTS="www.tdtchannels.com,rtve.es,mitele.es"
// Un dominio en la lista también permite sus subdominios
// (p. ej. "rtve.es" permite "ztnr.rtve.es").
// Si la variable no está definida, el proxy funciona en modo abierto
// (útil sólo para desarrollo local) y se avisa por consola.
const ALLOWED_PROXY_HOSTS = (process.env.ALLOWED_PROXY_HOSTS || "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

if (ALLOWED_PROXY_HOSTS.length === 0) {
  console.warn(
    "[AVJ PLAY] ALLOWED_PROXY_HOSTS no está configurada: /proxy aceptará " +
    "cualquier dominio. Configúrala en producción para restringir el proxy."
  );
}

function isHostAllowed(hostname) {
  if (ALLOWED_PROXY_HOSTS.length === 0) return true; // modo abierto (sólo dev)
  const h = hostname.toLowerCase();
  return ALLOWED_PROXY_HOSTS.some((allowed) => h === allowed || h.endsWith("." + allowed));
}

/* ------------------------------------------------------------------ */
/* Caché en memoria del catálogo normalizado                           */
/* ------------------------------------------------------------------ */
const catalogCache = {
  data: null,          // último catálogo normalizado válido
  fetchedAt: 0,         // timestamp (ms) de cuándo se obtuvo con éxito
  inFlight: null,        // promesa en curso, para no disparar descargas duplicadas
};

function isCacheFresh() {
  return catalogCache.data !== null && (Date.now() - catalogCache.fetchedAt) < CACHE_TTL_MS;
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // quita acentos
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Convierte la estructura anidada de TDTChannels
 * (countries[].ambits[].channels[]) en un array plano y compacto con
 * sólo los campos que necesita el frontend.
 */
function normalizeCatalog(raw) {
  const channels = [];
  const countries = Array.isArray(raw.countries) ? raw.countries : [];

  for (const country of countries) {
    const countryName = country.name || "";
    const ambits = Array.isArray(country.ambits) ? country.ambits : [];

    for (const ambit of ambits) {
      const groupName = ambit.name || "Otros";
      const ambitChannels = Array.isArray(ambit.channels) ? ambit.channels : [];

      for (const ch of ambitChannels) {
        const id = slugify(ch.epg_id || `${countryName}-${groupName}-${ch.name}`);
        const streams = Array.isArray(ch.options)
          ? ch.options
              .filter((o) => o && o.url)
              .map((o) => ({
                format: o.format || null,
                url: o.url,
                res: o.res || null,
                lang: o.lang || null,
                geo: o.geo2 || null,
              }))
          : [];

        channels.push({
          id,
          name: ch.name || "Canal",
          logo: ch.logo || null,
          web: ch.web || null,
          epg_id: ch.epg_id || null,
          group: groupName,
          country: countryName,
          streams,
          extra_info: Array.isArray(ch.extra_info) ? ch.extra_info : [],
        });
      }
    }
  }

  return channels;
}

/**
 * Descarga y normaliza el catálogo. Usa un "single-flight" simple:
 * si ya hay una descarga en curso, todas las peticiones concurrentes
 * esperan esa misma promesa en lugar de disparar descargas duplicadas.
 */
async function refreshCatalog() {
  if (catalogCache.inFlight) return catalogCache.inFlight;

  catalogCache.inFlight = (async () => {
    const res = await fetch(CATALOG_SOURCE_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (AVJPLAY-Catalog)" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status + " al descargar el catálogo");

    const raw = await res.json();
    const channels = normalizeCatalog(raw);
    if (!channels.length) throw new Error("El catálogo se descargó pero no contiene canales");

    catalogCache.data = channels;
    catalogCache.fetchedAt = Date.now();
    return channels;
  })();

  try {
    return await catalogCache.inFlight;
  } finally {
    catalogCache.inFlight = null;
  }
}

/* ------------------------------------------------------------------ */
/* Rutas                                                               */
/* ------------------------------------------------------------------ */
app.get("/", (req, res) => {
  res.send("AVJ PLAY backend activo. Endpoints: /health, /api/channels, /proxy?url=<URL_CODIFICADA>");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/channels", async (req, res) => {
  // 1. Caché vigente: se sirve directamente, sin volver a descargar.
  if (isCacheFresh()) {
    return res.json({
      source: CATALOG_SOURCE_URL,
      count: catalogCache.data.length,
      cached: true,
      stale: false,
      cached_at: new Date(catalogCache.fetchedAt).toISOString(),
      ttl_minutes: CACHE_TTL_MINUTES,
      channels: catalogCache.data,
    });
  }

  // 2. Caché ausente o caducada: intenta refrescar.
  try {
    const channels = await refreshCatalog();
    return res.json({
      source: CATALOG_SOURCE_URL,
      count: channels.length,
      cached: false,
      stale: false,
      cached_at: new Date(catalogCache.fetchedAt).toISOString(),
      ttl_minutes: CACHE_TTL_MINUTES,
      channels,
    });
  } catch (err) {
    // 3. La fuente falla, pero existe una caché anterior (aunque esté
    //    caducada): se devuelve esa caché en lugar de un error, avisando
    //    de que es una versión no actualizada.
    if (catalogCache.data) {
      return res.json({
        source: CATALOG_SOURCE_URL,
        count: catalogCache.data.length,
        cached: true,
        stale: true,
        cached_at: new Date(catalogCache.fetchedAt).toISOString(),
        ttl_minutes: CACHE_TTL_MINUTES,
        warning: "No se pudo actualizar el catálogo; se devuelve la última versión en caché.",
        error: err.message,
        channels: catalogCache.data,
      });
    }

    // 4. No hay caché y la fuente falló: error claro en JSON.
    return res.status(502).json({
      error: "No se pudo obtener el catálogo de canales y no hay caché disponible.",
      source: CATALOG_SOURCE_URL,
      details: err.message,
    });
  }
});

app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: "Falta el parámetro ?url=" });

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (e) {
    return res.status(400).json({ error: "URL inválida." });
  }

  if (!isHostAllowed(targetUrl.hostname)) {
    return res.status(403).json({
      error: "Dominio no permitido por ALLOWED_PROXY_HOSTS.",
      hostname: targetUrl.hostname,
    });
  }

  try {
    const upstream = await fetch(target, {
      headers: { "User-Agent": "Mozilla/5.0 (AVJPLAY-Proxy)" },
    });

    // Reenvía el content-type original (m3u8, ts, mp4, imágenes de logos, etc.)
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    res.setHeader("content-type", contentType);
    res.setHeader("cache-control", "no-store");

    // Si es una playlist m3u8, reescribimos las URLs relativas para que
    // también pasen por el proxy (necesario para HLS con segmentos externos).
    if (contentType.includes("mpegurl") || target.endsWith(".m3u8") || target.endsWith(".m3u")) {
      const text = await upstream.text();
      const base = new URL(target);
      const rewritten = text
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) return line;
          const abs = new URL(trimmed, base).toString();
          return "/proxy?url=" + encodeURIComponent(abs);
        })
        .join("\n");
      return res.send(rewritten);
    }

    upstream.body.pipe(res);
  } catch (err) {
    res.status(502).json({ error: "No se pudo obtener el recurso.", details: err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log("AVJ PLAY backend escuchando en http://" + HOST + ":" + PORT);
  console.log("Catálogo fuente: " + CATALOG_SOURCE_URL + " (TTL " + CACHE_TTL_MINUTES + " min)");
});
