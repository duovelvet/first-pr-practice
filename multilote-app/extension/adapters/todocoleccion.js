// Adaptador de Todocolección. Mismo esquema y misma política que adapters/wallapop.js: nada de endpoints inventados.
// Aquí la web suele ser de formularios clásicos con token CSRF y cookie de sesión: el perfil aprendido lo cubre
// (cuerpos urlencoded/multipart, token leído de la propia página, id sacado de la URL tras la redirección,
// requireSession=false) y APRENDE también la URL real del formulario de «vender», por eso UPLOAD_URLS.todocoleccion en
// config.js es solo un punto de partida.
MLAdapters.register({
  id: "todocoleccion",
  hostRe: /(^|\.)todocoleccion\.net$/i,
  loginPath: null,
  dom: {
    publish: {
      title: 'input[name="title"], input#title',
      description: 'textarea[name="description"], textarea#description',
      price: 'input[name="price"], input#price',
      photos: 'input[type="file"]',
      submit: 'button[type="submit"]',
    },
    delete: { ...MLDom.DEFAULT_DELETE },
  },
  confirm: null,
  idFromUrl: null,
  api: { verified: false, publish: null, delete: null },
});
