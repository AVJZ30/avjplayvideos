/**
 * ANTENA — proxy/backend opcional
 * -------------------------------
 * La web funciona sola (100% estática, sin backend) usando proxies CORS
 * públicos como respaldo. Para un uso serio o en producción, es mejor
 * tener tu propio "banco de render": un pequeño servidor que reenvía
 * (proxy) las listas M3U/M3U8 y los segmentos de vídeo, evitando así
 * bloqueos de CORS y dependencias de terceros.
 *
 * Uso:
 *   npm install express node-fetch cors
 *   node server.js
 *
 * Luego, en index.html, cambia las URLs de listas y de streams para que
 * pasen por:  http://localhost:8787/proxy?url=<URL_ORIGINAL_CODIFICADA>
 */
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 8787;

app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Falta el parámetro ?url=");

  try {
    const upstream = await fetch(target, {
      headers: { "User-Agent": "Mozilla/5.0 (ANTENA-Proxy)" },
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
    res.status(502).send("No se pudo obtener el recurso: " + err.message);
  }
});

app.listen(PORT, () => {
  console.log("ANTENA proxy escuchando en http://localhost:" + PORT);
});
