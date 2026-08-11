/**
 * AVJ PLAY — configuración de fuentes de datos
 * ------------------------------------------------------------------
 * Un único lugar para las URLs de las tres fuentes que consume el
 * frontend. Cambiar aquí no requiere tocar app.js ni el backend.
 */
window.AVJPLAY_CONFIG = {
  // Backend de TV en vivo ya funcionando (server.js en Render).
  // No cambiar sin tener claro que el backend expone esa misma ruta.
  CHANNELS_API_URL: "https://avjplay-backend.onrender.com/api/channels",

  // Fuente de películas. Estructura esperada:
  // { "movies": [ { id, title, description, poster, year, genre, streamUrl } ] }
  // Todavía no existe una fuente real: se deja vacío a propósito.
  // En cuanto exista, basta con poner aquí su URL — el frontend ya
  // sabe leerla y no hace falta cambiar nada más.
  MOVIES_API_URL: "",

  // Fuente de series. Estructura esperada:
  // { "series": [ { id, title, description, poster, year, genre,
  //                 seasons: [ { number, episodes: [ { number, title, streamUrl } ] } ] } ] }
  // Todavía no existe una fuente real: se deja vacío a propósito.
  SERIES_API_URL: "",
};
