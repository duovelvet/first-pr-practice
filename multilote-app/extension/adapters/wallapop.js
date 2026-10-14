// Adaptador de Wallapop.
//
// Todo lo que depende del sitio real vive aquí, como DATOS. Estado actual:
//   · dom.publish: selectores genéricos, SIN verificar contra el formulario real.
//   · confirm:     null -> tras pulsar «publicar» se detecta el resultado por cambio de URL.
//   · api:         verified=false -> el modo API está DESACTIVADO. Los planes (publish/delete) se rellenan a partir
//                  del tráfico real capturado con tools/inspect-dom.js; hasta entonces no se llama a ninguna API
//                  privada y todo se hace por DOM.
//
// Cuando haya captura, rellenar (ejemplo de forma, valores inventados):
//   confirm: { method: "POST", path: /^\/api\/v3\/items\/?$/, extract: { id: "id", slug: "web_slug" },
//              urlTemplate: "https://es.wallapop.com/item/{{slug}}" }
//   idFromUrl: (url) => (/-([a-z0-9]+)$/i.exec(new URL(url).pathname) || [])[1],
//   api: { verified: true,
//          publish: { requireSession: true, urlTemplate: "https://es.wallapop.com/item/{{slug}}",
//                     steps: [{ name: "crear", method: "POST", url: "https://api.wallapop.com/api/v3/items",
//                               body: { kind: "json", value: { title: "{{title}}", price: "{{price}}" } },
//                               extract: { id: "id", slug: "web_slug" } }] },
//          delete: { idempotent: true,
//                    steps: [{ name: "borrar", method: "DELETE", url: "https://api.wallapop.com/api/v3/items/{{id}}",
//                              expect: [200, 204, 404] }] } },
MLAdapters.register({
  id: "wallapop",
  hostRe: /(^|\.)wallapop\.(com|net|es)$/i,
  loginPath: null, // p. ej. /\/(login|signin)/i — por confirmar
  dom: {
    publish: {
      title: 'input[name="title"], input#title',
      description: 'textarea[name="description"], textarea#description',
      price: 'input[name="sale_price"], input#sale_price, input[name="price"]',
      photos: 'input[type="file"]',
      submit: 'button[type="submit"]',
    },
    delete: { ...MLDom.DEFAULT_DELETE },
  },
  confirm: null,
  idFromUrl: null,
  api: { verified: false, publish: null, delete: null },
});
