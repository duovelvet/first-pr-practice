// Adaptador de Wallapop. Todo lo que depende del sitio vive aquí o en el PERFIL APRENDIDO, siempre como datos.
//
// Estado en el repositorio (a propósito):
//   · dom.publish / dom.delete: selectores y textos genéricos, SIN verificar contra el sitio real.
//   · confirm, idFromUrl, api: vacíos y api.verified = false. No se escriben endpoints a mano: no se conocen, y
//     «verified» no puede afirmarse en un fichero; solo puede demostrarse en el navegador de cada usuario.
//
// Cómo se activa el modo API (sin consola; ver README «Modo API: aprender y verificar»):
//   1. Popup → Modo API → Wallapop → «Aprender»: el usuario sube y borra un anuncio de prueba con valores centinela.
//   2. lib/plan-synth.js deduce de esa grabación el tap de confirmación, idFromUrl y los planes publicar/retirar.
//      El resultado se guarda como PERFIL en chrome.storage.local (estado «draft»).
//   3. «Verificar»: la extensión publica y retira un anuncio de prueba POR API. Solo si funciona, el perfil pasa a
//      «verified» (ligado al hash del plan) y lib/profiles.js lo fusiona con este adaptador (MLProfiles.resolve).
//   4. Si el sitio cambia y la API responde distinto 2 veces seguidas, el perfil pasa a «stale» y vuelve el DOM.
// Un adaptador puede fijar api/confirm/idFromUrl aquí solo si se verificaron contra el sitio real (api.verified = true).
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
      // Primer paso del asistente de subida (visto en el diagnóstico real): hay que elegir qué se sube antes de que
      // aparezcan los campos. Solo lo usa el aprendizaje automático.
      start: /algo que ya no necesito/i,
    },
    delete: { ...MLDom.DEFAULT_DELETE },
  },
  confirm: null,
  idFromUrl: null,
  api: { verified: false, publish: null, delete: null },
});
