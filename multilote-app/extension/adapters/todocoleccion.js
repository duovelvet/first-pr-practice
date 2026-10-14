// Adaptador de Todocolección. Mismo esquema que adapters/wallapop.js (léelo para la forma de api/confirm).
// Todo está SIN verificar: selectores genéricos y modo API desactivado. Pendiente de inspeccionar el formulario
// real (categoría obligatoria, precio fijo/subasta…) y su tráfico. Una sesión basada solo en cookies se
// declara con requireSession: false en el plan; si usa CSRF/cabeceras, el gancho las reutiliza solas.
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
