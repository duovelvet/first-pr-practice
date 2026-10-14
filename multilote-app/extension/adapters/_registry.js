// Registro de adaptadores por marketplace (content script). Cargar ANTES que adapters/*.js y content.js.
const MLAdapters = (() => {
  const list = [];
  return {
    register: (adapter) => list.push(adapter),
    forHost: (hostname) => list.find((a) => a.hostRe.test(hostname)) || null,
    list,
  };
})();
