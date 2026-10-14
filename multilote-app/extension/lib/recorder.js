// Modo aprendizaje (content script): si el popup activó la grabación para este marketplace, activa la captura en el
// gancho de la página y retransmite cada petición mutante a background. Además captura los envíos de formularios
// NATIVOS (navegaciones), que no pasan por fetch/XHR y por tanto el gancho no ve.
(async () => {
  const adapter = MLAdapters.forHost(location.hostname);
  if (!adapter) return;
  const st = await chrome.runtime.sendMessage({ type: "rec-state" }).catch(() => null);
  if (!st || !st.active || st.marketplace !== adapter.id) return;
  if (!(await MLBridge.whenReady())) return;

  MLBridge.setRecording(true);
  MLBridge.onRecCall((call) => chrome.runtime.sendMessage({ type: "rec-call", call }).catch(() => {}));

  const SECRET_KEY = /pass(word)?|secret|token|authoriz|cookie|session|jwt|bearer/i;
  window.addEventListener(
    "submit",
    (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      const method = (form.method || "get").toUpperCase();
      if (method === "GET") return;
      const fields = {};
      const files = [];
      for (const [k, v] of new FormData(form).entries()) {
        if (typeof v === "string") fields[k] = k in fields ? [].concat(fields[k], v) : SECRET_KEY.test(k) ? "<redacted>" : v;
        else if (v.size > 0) files.push({ field: k, type: v.type, size: v.size });
      }
      const hidden = [...form.querySelectorAll("input[type=hidden][name]")].map((i) => i.name);
      const multipart = /multipart/i.test(form.enctype || "");
      const call = { kind: "nav", t: Date.now(), method, url: form.action || location.href, hasSession: false, req: { type: multipart ? "multipart" : "urlencoded", fields, hidden, files } };
      // Si la web gestiona el envío con JS (preventDefault), lo verá el gancho como fetch/XHR: no duplicar.
      setTimeout(() => {
        if (!e.defaultPrevented) chrome.runtime.sendMessage({ type: "rec-call", call }).catch(() => {});
      }, 0);
    },
    true
  );
})();
