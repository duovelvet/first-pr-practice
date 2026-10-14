// Adaptador de Milanuncios. Mismo esquema que adapters/wallapop.js. Sin verificar: selectores genéricos, API desactivada.
MLAdapters.register({
  id: "milanuncios",
  hostRe: /(^|\.)milanuncios\.com$/i,
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
