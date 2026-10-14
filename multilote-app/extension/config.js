// Rellena con los valores de tu proyecto Supabase (Settings > API).
// La anon key es pública; los datos están protegidos por RLS.
const MULTILOTE_CONFIG = {
  SUPABASE_URL: "https://your-project.supabase.co",
  SUPABASE_ANON_KEY: "your-anon-key",
  WEB_URL: "https://multilote.com",
  // URL donde se crea un anuncio nuevo en cada marketplace.
  UPLOAD_URLS: {
    wallapop: "https://es.wallapop.com/app/catalog/upload",
    vinted: "https://www.vinted.es/items/new",
    milanuncios: "https://www.milanuncios.com/publicar-anuncio/",
  },
};
