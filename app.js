/**
 * AVJ PLAY — frontend
 * ------------------------------------------------------------------
 * Consume:
 *   - CHANNELS_API_URL  (TV en vivo, ya en producción)
 *   - MOVIES_API_URL    (opcional, "Próximamente" si está vacío)
 *   - SERIES_API_URL    (opcional, "Próximamente" si está vacío)
 *
 * No hace scraping, no intenta saltar CORS/DRM/geobloqueo/autenticación.
 * Los favoritos se guardan sólo en localStorage (sin base de datos).
 */
(function () {
  "use strict";

  const CFG = window.AVJPLAY_CONFIG || {};
  const CHANNELS_API_URL = CFG.CHANNELS_API_URL || "";
  const MOVIES_API_URL = CFG.MOVIES_API_URL || "";
  const SERIES_API_URL = CFG.SERIES_API_URL || "";
  const FAVORITES_KEY = "avjplay:favorites";

  /* ================================================================
     PURE HELPERS (sin DOM — fáciles de testear de forma aislada)
     ================================================================ */

  function normalizeText(str) {
    return String(str || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function buildCategories(channels) {
    const map = new Map();
    for (const c of channels) {
      const g = c.group || "Sin categoría";
      map.set(g, (map.get(g) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }

  function filterChannels(channels, { query, category, idsFilter } = {}) {
    let list = channels;
    if (idsFilter) list = list.filter((c) => idsFilter.has(c.id));
    if (category && category !== "all") list = list.filter((c) => c.group === category);
    if (query) {
      const q = normalizeText(query);
      list = list.filter((c) => {
        return (
          normalizeText(c.name).includes(q) ||
          normalizeText(c.group).includes(q) ||
          normalizeText(c.country).includes(q)
        );
      });
    }
    return list;
  }

  /**
   * De channel.streams, decide qué se puede reproducir con este
   * reproductor (sólo HLS/M3U8, tal y como pide la especificación).
   */
  function pickPlayableStreams(streams) {
    if (!Array.isArray(streams) || streams.length === 0) {
      return { ok: false, reason: "empty" };
    }
    const m3u8s = streams.filter((s) => s && s.format === "m3u8" && s.url);
    if (m3u8s.length === 0) {
      return { ok: false, reason: "no-compatible-format", available: streams.map((s) => s && s.format) };
    }
    return { ok: true, streams: m3u8s };
  }

  // Expuesto para poder testear estas funciones puras desde Node sin DOM.
  window.__AVJPLAY_TESTABLE__ = { normalizeText, buildCategories, filterChannels, pickPlayableStreams };

  /* ================================================================
     ESTADO
     ================================================================ */
  const state = {
    channels: [],
    channelsById: new Map(),
    apiCount: 0,
    category: "all",
    query: "",
    favorites: loadFavorites(),
    currentView: "inicio",
    moviesLoaded: false,
    seriesLoaded: false,
    renderToken: 0,

    // reproductor
    hls: null,
    current: null,
    streamQueue: [],
    streamIndex: 0,
    mediaRecoverAttempted: false,
  };

  function loadFavorites() {
    try {
      const raw = localStorage.getItem(FAVORITES_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) {
      console.warn("[AVJ PLAY] No se pudieron leer los favoritos guardados:", e);
      return new Set();
    }
  }
  function saveFavorites() {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(state.favorites)));
    } catch (e) {
      console.warn("[AVJ PLAY] No se pudieron guardar los favoritos:", e);
    }
  }
  function toggleFavorite(id) {
    if (state.favorites.has(id)) state.favorites.delete(id);
    else state.favorites.add(id);
    saveFavorites();
  }

  /* ================================================================
     DOM REFS
     ================================================================ */
  const $ = (sel) => document.querySelector(sel);

  const navBtns = document.querySelectorAll(".nav-btn");
  const searchInput = $("#searchInput");

  const statusBar = $("#statusBar");
  const statusText = $("#statusText");
  const statusSpinner = $("#statusSpinner");
  const statusRetry = $("#statusRetry");

  const categoryChips = $("#categoryChips");
  const grid = $("#grid");
  const emptyState = $("#emptyState");
  const resultsMeta = $("#resultsMeta");
  const tvSectionTitle = $("#tvSectionTitle");

  const favGrid = $("#favGrid");
  const favEmptyState = $("#favEmptyState");
  const favMeta = $("#favMeta");

  const moviesContent = $("#moviesContent");
  const seriesContent = $("#seriesContent");

  const views = {
    inicio: $("#view-tv"),
    tv: $("#view-tv"),
    movies: $("#view-movies"),
    series: $("#view-series"),
    favorites: $("#view-favorites"),
  };

  const scrim = $("#scrim");
  const playerPanel = $("#playerPanel");
  const video = $("#video");
  const playerTitle = $("#playerTitle");
  const playerSub = $("#playerSub");
  const playerLogo = $("#playerLogo");
  const playerFavBtn = $("#playerFavBtn");
  const playerList = $("#playerList");
  const roStatus = $("#roStatus");
  const roGroup = $("#roGroup");
  const roCountry = $("#roCountry");

  const loadingOverlay = $("#loadingOverlay");
  const errorOverlay = $("#errorOverlay");
  const errorMessage = $("#errorMessage");
  const errorWebLink = $("#errorWebLink");
  const retryBtn = $("#retryBtn");
  const noStreamOverlay = $("#noStreamOverlay");
  const noStreamWebLink = $("#noStreamWebLink");

  /* ================================================================
     UTILS DOM
     ================================================================ */
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (s) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
  }

  function setStatus(mode, text) {
    statusBar.classList.remove("ok", "error");
    statusRetry.hidden = true;
    statusSpinner.hidden = false;
    if (mode === "loading") {
      statusText.textContent = text || "Cargando canales…";
    } else if (mode === "ok") {
      statusBar.classList.add("ok");
      statusSpinner.hidden = true;
      statusText.textContent = text;
    } else if (mode === "error") {
      statusBar.classList.add("error");
      statusSpinner.hidden = true;
      statusText.textContent = text || "No se pudo cargar el catálogo.";
      statusRetry.hidden = false;
    }
  }

  /* ================================================================
     CARGA DEL CATÁLOGO DE TV (backend propio, con su caché de 10 min)
     ================================================================ */
  async function loadChannels() {
    if (!CHANNELS_API_URL) {
      setStatus("error", "No hay CHANNELS_API_URL configurada.");
      return;
    }
    setStatus("loading", "Cargando canales…");
    try {
      const res = await fetch(CHANNELS_API_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const channels = Array.isArray(data.channels) ? data.channels : [];
      if (!channels.length) throw new Error("La API respondió sin canales.");

      state.channels = channels;
      state.channelsById = new Map(channels.map((c) => [c.id, c]));
      state.apiCount = typeof data.count === "number" ? data.count : channels.length;

      setStatus("ok", state.apiCount + " canales disponibles");
      renderCategoryChips();
      renderGrid();
      renderFavorites();
    } catch (err) {
      console.error("[AVJ PLAY] Error al cargar /api/channels:", err);
      setStatus("error", "No se pudo cargar el catálogo.");
    }
  }

  statusRetry.addEventListener("click", loadChannels);

  /* ================================================================
     CATEGORÍAS + BÚSQUEDA (todo en memoria, sin volver a pedir la API)
     ================================================================ */
  function renderCategoryChips() {
    const cats = buildCategories(state.channels);
    categoryChips.innerHTML = "";

    const allChip = makeChip("Todos", state.channels.length, state.category === "all");
    allChip.addEventListener("click", () => { state.category = "all"; renderCategoryChips(); renderGrid(); });
    categoryChips.appendChild(allChip);

    for (const [name, count] of cats) {
      const chip = makeChip(name, count, state.category === name);
      chip.addEventListener("click", () => { state.category = name; renderCategoryChips(); renderGrid(); });
      categoryChips.appendChild(chip);
    }
  }
  function makeChip(label, count, active) {
    const b = document.createElement("button");
    b.className = "chip" + (active ? " active" : "");
    b.innerHTML = escapeHtml(label) + '<span class="cnt">' + count + "</span>";
    return b;
  }

  let searchDebounce = null;
  searchInput.addEventListener("input", (e) => {
    clearTimeout(searchDebounce);
    const value = e.target.value;
    searchDebounce = setTimeout(() => {
      state.query = value;
      renderGrid();
    }, 120);
  });

  /* ================================================================
     RENDER DE LA GRID (chunked para no bloquear con 750+ canales)
     ================================================================ */
  function cardTemplate(ch) {
    const div = document.createElement("button");
    div.className = "card";
    const logoHtml = ch.logo
      ? '<img src="' + escapeHtml(ch.logo) + '" alt="" loading="lazy" onerror="this.parentElement.innerHTML=\'<div class=&quot;fallback&quot;>' +
        escapeHtml((ch.name || "?").slice(0, 2).toUpperCase()) + '</div>\'">'
      : '<div class="fallback">' + escapeHtml((ch.name || "?").slice(0, 2).toUpperCase()) + "</div>";

    div.innerHTML =
      '<button type="button" class="card-fav' + (state.favorites.has(ch.id) ? " active" : "") + '" data-fav-id="' + escapeHtml(ch.id) + '" aria-label="Favorito" title="Favorito">★</button>' +
      '<div class="card-logo">' + logoHtml + "</div>" +
      '<div class="card-name">' + escapeHtml(ch.name) + "</div>" +
      '<div class="card-meta"><span class="card-group">' + escapeHtml(ch.group || "") + "</span>" +
      (ch.country ? '<span class="card-country">' + escapeHtml(ch.country) + "</span>" : "") +
      "</div>";

    div.addEventListener("click", (e) => {
      if (e.target.closest("[data-fav-id]")) return; // el click en la estrella no abre el player
      openPlayer(ch);
    });
    const favBtn = div.querySelector("[data-fav-id]");
    favBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFavorite(ch.id);
      favBtn.classList.toggle("active");
      renderFavorites();
    });
    return div;
  }

  function renderInto(container, emptyEl, list, emptyHtml) {
    const myToken = ++state.renderToken;
    container.innerHTML = "";
    if (!list.length) {
      container.style.display = "none";
      if (emptyEl) { emptyEl.hidden = false; emptyEl.innerHTML = emptyHtml; }
      return;
    }
    container.style.display = "grid";
    if (emptyEl) emptyEl.hidden = true;

    const CHUNK = 60;
    let i = 0;
    function renderChunk() {
      if (myToken !== state.renderToken) return; // se canceló por un filtro más nuevo
      const frag = document.createDocumentFragment();
      const end = Math.min(i + CHUNK, list.length);
      for (; i < end; i++) frag.appendChild(cardTemplate(list[i]));
      container.appendChild(frag);
      if (i < list.length) requestAnimationFrame(renderChunk);
    }
    renderChunk();
  }

  function renderGrid() {
    const list = filterChannels(state.channels, { query: state.query, category: state.category });
    resultsMeta.textContent = list.length + " resultado" + (list.length === 1 ? "" : "s");
    renderInto(grid, emptyState, list,
      '<h3>Sin resultados</h3><p>No hay canales que coincidan con tu búsqueda o categoría.</p>' +
      '<button class="btn ghost" id="clearFiltersBtn">Quitar filtros</button>'
    );
    const clearBtn = $("#clearFiltersBtn");
    if (clearBtn) clearBtn.addEventListener("click", () => {
      state.category = "all"; state.query = ""; searchInput.value = "";
      renderCategoryChips(); renderGrid();
    });
  }

  function renderFavorites() {
    const favList = state.channels.filter((c) => state.favorites.has(c.id));
    favMeta.textContent = favList.length + " favorito" + (favList.length === 1 ? "" : "s");
    renderInto(favGrid, favEmptyState, favList,
      '<h3>Todavía no tienes favoritos</h3><p>Pulsa la estrella de cualquier canal para guardarlo aquí. Se guarda sólo en este navegador.</p>'
    );
  }

  /* ================================================================
     NAVEGACIÓN
     ================================================================ */
  function setView(view) {
    state.currentView = view;
    navBtns.forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    Object.entries(views).forEach(([key, el]) => {
      if (!el) return;
      const shouldShow = viewElementFor(view) === el;
      el.hidden = !shouldShow;
    });
    tvSectionTitle.textContent = view === "inicio" ? "Inicio · TV en vivo" : "TV en vivo";

    if (view === "movies") loadMoviesIfNeeded();
    if (view === "series") loadSeriesIfNeeded();
    if (view === "favorites") renderFavorites();
  }
  function viewElementFor(view) {
    if (view === "inicio" || view === "tv") return views.tv;
    return views[view];
  }
  navBtns.forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  /* ================================================================
     PELÍCULAS Y SERIES — fuentes independientes, sin inventar datos
     ================================================================ */
  function comingSoonHtml(title, note) {
    return (
      '<div class="coming-soon"><span class="icon">🎬</span><h3>' + escapeHtml(title) + " — Próximamente</h3>" +
      "<p>" + escapeHtml(note) + "</p></div>"
    );
  }

  async function loadMoviesIfNeeded() {
    if (state.moviesLoaded) return;
    if (!MOVIES_API_URL) {
      moviesContent.innerHTML = comingSoonHtml(
        "Películas",
        "Todavía no hay una fuente de películas configurada (MOVIES_API_URL). En cuanto exista, aparecerán aquí automáticamente."
      );
      state.moviesLoaded = true;
      return;
    }
    moviesContent.innerHTML = '<div class="empty-state"><span class="spinner"></span> Cargando películas…</div>';
    try {
      const res = await fetch(MOVIES_API_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const movies = Array.isArray(data.movies) ? data.movies : [];
      if (!movies.length) {
        moviesContent.innerHTML = comingSoonHtml("Películas", "La fuente configurada no devolvió ninguna película todavía.");
      } else {
        renderMovies(movies);
      }
      state.moviesLoaded = true;
    } catch (err) {
      console.error("[AVJ PLAY] Error al cargar MOVIES_API_URL:", err);
      moviesContent.innerHTML = comingSoonHtml("Películas", "No se pudo cargar la fuente de películas ahora mismo.");
    }
  }

  function renderMovies(movies) {
    const grid = document.createElement("div");
    grid.className = "grid";
    const frag = document.createDocumentFragment();
    for (const m of movies) {
      const card = document.createElement("button");
      card.className = "card";
      const posterHtml = m.poster
        ? '<img src="' + escapeHtml(m.poster) + '" alt="" loading="lazy">'
        : '<div class="fallback">' + escapeHtml((m.title || "?").slice(0, 2).toUpperCase()) + "</div>";
      card.innerHTML =
        '<div class="card-logo" style="height:auto;aspect-ratio:2/3;">' + posterHtml + "</div>" +
        '<div class="card-name">' + escapeHtml(m.title || "Sin título") + "</div>" +
        '<div class="card-meta"><span class="card-group">' + escapeHtml(m.genre || "") + "</span>" +
        '<span class="card-country">' + escapeHtml(m.year || "") + "</span></div>";
      card.addEventListener("click", () => openMoviePlayer(m));
      frag.appendChild(card);
    }
    grid.appendChild(frag);
    moviesContent.innerHTML = "";
    moviesContent.appendChild(grid);
  }

  function openMoviePlayer(movie) {
    if (!movie.streamUrl) {
      alert("Esta película todavía no tiene un stream disponible.");
      return;
    }
    openPlayer({
      id: "movie-" + movie.id,
      name: movie.title,
      logo: movie.poster,
      group: movie.genre || "Película",
      country: movie.year ? String(movie.year) : "",
      web: movie.web || "",
      streams: [{ format: "m3u8", url: movie.streamUrl }],
    }, { relatedList: [] });
  }

  async function loadSeriesIfNeeded() {
    if (state.seriesLoaded) return;
    if (!SERIES_API_URL) {
      seriesContent.innerHTML = comingSoonHtml(
        "Series",
        "Todavía no hay una fuente de series configurada (SERIES_API_URL). En cuanto exista, aparecerán aquí automáticamente."
      );
      state.seriesLoaded = true;
      return;
    }
    seriesContent.innerHTML = '<div class="empty-state"><span class="spinner"></span> Cargando series…</div>';
    try {
      const res = await fetch(SERIES_API_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const series = Array.isArray(data.series) ? data.series : [];
      if (!series.length) {
        seriesContent.innerHTML = comingSoonHtml("Series", "La fuente configurada no devolvió ninguna serie todavía.");
      } else {
        renderSeries(series);
      }
      state.seriesLoaded = true;
    } catch (err) {
      console.error("[AVJ PLAY] Error al cargar SERIES_API_URL:", err);
      seriesContent.innerHTML = comingSoonHtml("Series", "No se pudo cargar la fuente de series ahora mismo.");
    }
  }

  function renderSeries(series) {
    const grid = document.createElement("div");
    grid.className = "grid";
    const frag = document.createDocumentFragment();
    for (const s of series) {
      const card = document.createElement("button");
      card.className = "card";
      const posterHtml = s.poster
        ? '<img src="' + escapeHtml(s.poster) + '" alt="" loading="lazy">'
        : '<div class="fallback">' + escapeHtml((s.title || "?").slice(0, 2).toUpperCase()) + "</div>";
      const firstEp = s.seasons && s.seasons[0] && s.seasons[0].episodes && s.seasons[0].episodes[0];
      card.innerHTML =
        '<div class="card-logo" style="height:auto;aspect-ratio:2/3;">' + posterHtml + "</div>" +
        '<div class="card-name">' + escapeHtml(s.title || "Sin título") + "</div>" +
        '<div class="card-meta"><span class="card-group">' + escapeHtml(s.genre || "") + "</span>" +
        '<span class="card-country">' + escapeHtml(s.year || "") + "</span></div>";
      card.addEventListener("click", () => {
        if (!firstEp || !firstEp.streamUrl) { alert("Esta serie todavía no tiene episodios con stream disponible."); return; }
        openPlayer({
          id: "series-" + s.id,
          name: s.title + " — T" + s.seasons[0].number + " E" + firstEp.number + " · " + firstEp.title,
          logo: s.poster,
          group: s.genre || "Serie",
          country: s.year ? String(s.year) : "",
          web: s.web || "",
          streams: [{ format: "m3u8", url: firstEp.streamUrl }],
        }, { relatedList: [] });
      });
      frag.appendChild(card);
    }
    grid.appendChild(frag);
    seriesContent.innerHTML = "";
    seriesContent.appendChild(grid);
  }

  /* ================================================================
     REPRODUCTOR — HLS con diagnóstico real en consola
     ================================================================ */
  function hideAllOverlays() {
    loadingOverlay.hidden = true;
    errorOverlay.hidden = true;
    noStreamOverlay.hidden = true;
  }

  function destroyHls() {
    if (state.hls) {
      try { state.hls.destroy(); } catch (e) { /* noop */ }
      state.hls = null;
    }
  }

  function openPlayer(ch, opts) {
    state.current = ch;
    state.mediaRecoverAttempted = false;
    scrim.classList.add("open");
    playerPanel.classList.add("open");

    playerTitle.textContent = ch.name;
    playerSub.textContent = [ch.group, ch.country].filter(Boolean).join(" · ");
    roGroup.textContent = ch.group || "—";
    roCountry.textContent = ch.country || "—";
    playerLogo.innerHTML = ch.logo
      ? '<img src="' + escapeHtml(ch.logo) + '" alt="" onerror="this.parentElement.textContent=\'' + escapeHtml((ch.name || "?").slice(0, 1)) + '\'">'
      : escapeHtml((ch.name || "?").slice(0, 1));

    playerFavBtn.classList.toggle("active", state.favorites.has(ch.id));
    playerFavBtn.onclick = () => {
      toggleFavorite(ch.id);
      playerFavBtn.classList.toggle("active");
      renderGrid();
      renderFavorites();
    };

    renderRelatedList(opts && opts.relatedList !== undefined ? opts.relatedList : state.channels);

    hideAllOverlays();
    const pick = pickPlayableStreams(ch.streams);

    if (!pick.ok && pick.reason === "empty") {
      roStatus.textContent = "Sin stream";
      noStreamOverlay.hidden = false;
      noStreamWebLink.href = ch.web || "#";
      noStreamWebLink.style.display = ch.web ? "" : "none";
      console.info("[AVJ PLAY] Canal sin streams:", ch.id, ch.name);
      return;
    }
    if (!pick.ok && pick.reason === "no-compatible-format") {
      roStatus.textContent = "Formato no compatible";
      showError(
        "Este canal no ofrece ningún stream en un formato compatible con este reproductor (sólo se soporta HLS / M3U8)."
      );
      console.warn("[AVJ PLAY] Sin streams m3u8 para", ch.id, "formatos disponibles:", pick.available);
      return;
    }

    state.streamQueue = pick.streams;
    state.streamIndex = 0;
    attemptPlay();
  }

  function renderRelatedList(list) {
    playerList.innerHTML = "";
    if (!list || !list.length) return;
    const frag = document.createDocumentFragment();
    list.slice(0, 200).forEach((ch) => {
      const item = document.createElement("div");
      item.className = "player-list-item" + (state.current && ch.id === state.current.id ? " current" : "");
      const logo = ch.logo ? '<img src="' + escapeHtml(ch.logo) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : "📺";
      item.innerHTML = '<span class="ll">' + logo + "</span><span>" + escapeHtml(ch.name) + "</span>";
      item.addEventListener("click", () => openPlayer(ch));
      frag.appendChild(item);
    });
    playerList.appendChild(frag);
  }

  function attemptPlay() {
    const streamObj = state.streamQueue[state.streamIndex];
    if (!streamObj) { showError("No se pudo reproducir este canal ahora mismo."); return; }

    hideAllOverlays();
    loadingOverlay.hidden = false;
    roStatus.textContent = "Conectando…";

    destroyHls();
    video.removeAttribute("src");
    video.load();

    console.info("[AVJ PLAY] Intentando reproducir:", streamObj.url);

    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({ maxBufferLength: 30 });
      state.hls = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        loadingOverlay.hidden = true;
        roStatus.textContent = "En directo";
        video.play().catch((e) => console.warn("[AVJ PLAY] Autoplay bloqueado por el navegador:", e));
      });

      hls.on(Hls.Events.ERROR, (_evt, data) => {
        console.error("[AVJ PLAY][HLS ERROR]", {
          url: streamObj.url,
          type: data.type,
          details: data.details,
          fatal: data.fatal,
          responseCode: data.response && data.response.code,
          reason: data.reason || data.error,
        });
        if (data.fatal) handleFatalError(data.type, data.details);
      });

      hls.loadSource(streamObj.url);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = streamObj.url;
      const onReady = () => {
        loadingOverlay.hidden = true;
        roStatus.textContent = "En directo";
        video.play().catch((e) => console.warn("[AVJ PLAY] Autoplay bloqueado por el navegador:", e));
      };
      const onErr = () => {
        const err = video.error;
        console.error("[AVJ PLAY][NATIVE ERROR]", { url: streamObj.url, code: err && err.code, message: err && err.message });
        handleNativeError(err);
      };
      video.addEventListener("loadedmetadata", onReady, { once: true });
      video.addEventListener("error", onErr, { once: true });
    } else {
      roStatus.textContent = "No soportado";
      showError("Tu navegador no soporta reproducción HLS. Prueba con Chrome, Firefox, Edge o Safari actualizados.");
    }
  }

  function handleFatalError(type, details) {
    // Antes de rendirnos, si hay más streams m3u8 declarados por el
    // backend para este canal, probamos el siguiente (sigue siendo una
    // fuente legítima expuesta por la propia API, no un salto de
    // restricciones).
    if (state.streamIndex < state.streamQueue.length - 1) {
      state.streamIndex++;
      console.info("[AVJ PLAY] Probando el siguiente stream declarado para este canal…");
      state.mediaRecoverAttempted = false;
      attemptPlay();
      return;
    }

    if (type === "mediaError" && window.Hls && state.hls && !state.mediaRecoverAttempted) {
      state.mediaRecoverAttempted = true;
      console.info("[AVJ PLAY] Intentando recuperar error de media (hls.recoverMediaError)…");
      state.hls.recoverMediaError();
      return;
    }

    let message;
    if (type === "networkError") {
      message =
        "La fuente no permite la reproducción desde este navegador (posible restricción CORS, geobloqueo o control de origen del proveedor). No se intentará saltar esta restricción.";
    } else if (type === "mediaError") {
      message = "El formato o códec de este stream no es compatible con este reproductor.";
    } else {
      message = "No se pudo reproducir este canal ahora mismo. La fuente puede estar caída o bloqueando la reproducción externa. Revisa la consola para más detalle (" + (details || type) + ").";
    }
    roStatus.textContent = "Error de señal";
    showError(message);
  }

  function handleNativeError(err) {
    let message = "No se pudo reproducir este canal ahora mismo.";
    if (err) {
      switch (err.code) {
        case 2: // MEDIA_ERR_NETWORK
          message = "La fuente no permite la reproducción desde este navegador (posible restricción de red/CORS del proveedor). No se intentará saltar esta restricción.";
          break;
        case 3: // MEDIA_ERR_DECODE
          message = "El formato de este stream no es compatible con este reproductor.";
          break;
        case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
          message = "Esta fuente no es compatible con reproducción web directa (posible restricción del proveedor: CORS, DRM o autenticación).";
          break;
      }
    }
    roStatus.textContent = "Error de señal";
    showError(message);
  }

  function showError(message) {
    hideAllOverlays();
    errorOverlay.hidden = false;
    errorMessage.textContent = message;
    errorWebLink.href = (state.current && state.current.web) || "#";
    errorWebLink.style.display = state.current && state.current.web ? "" : "none";
  }

  retryBtn.addEventListener("click", () => {
    state.streamIndex = 0;
    state.mediaRecoverAttempted = false;
    attemptPlay();
  });

  function closePlayer() {
    scrim.classList.remove("open");
    playerPanel.classList.remove("open");
    destroyHls();
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  $("#playerClose").addEventListener("click", closePlayer);
  scrim.addEventListener("click", closePlayer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePlayer(); });

  /* ================================================================
     INIT
     ================================================================ */
  setView("inicio");
  loadChannels();
})();
