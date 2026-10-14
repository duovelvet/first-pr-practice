// MultiLote — gancho de red en el MUNDO PRINCIPAL de la página (manifest: world "MAIN", document_start).
//
// Qué hace:
//   1. OBSERVA las llamadas fetch/XHR de la propia web del marketplace. Solo extrae lo que el content script
//      le pide mediante "taps" declarativos (p. ej. «cuando la web haga POST /items, dame el campo id»).
//   2. EJECUTA llamadas a la API del marketplace en nombre de la extensión, reutilizando la sesión viva del
//      usuario (cookies + cabeceras que la propia web ya envía).
//
// Modelo de confianza:
//   · Corre con los mismos privilegios que la web: no obtiene nada que ella no tenga.
//   · Los tokens/cabeceras de sesión se guardan SOLO en memoria de este script y NUNCA salen de él:
//     no se envían al content script, ni al service worker, ni a Supabase.
//   · El canal con el content script (window.postMessage) NO es de confianza: cualquier script de la página
//     puede leerlo o enviar mensajes. Por eso solo viajan datos no sensibles (ids extraídos, estados HTTP).
//   · Solo hace peticiones https a la misma familia de dominios de la página (wallapop.*, todocoleccion.net…).
(() => {
  if (window.__mlHook) return;
  const FAMILIES = [
    /(^|\.)wallapop\.(com|net|es)$/i,
    /(^|\.)todocoleccion\.net$/i,
    /(^|\.)vinted\.(es|com)$/i,
    /(^|\.)milanuncios\.com$/i,
  ];
  const family = FAMILIES.find((r) => r.test(location.hostname));
  if (!family) return;
  window.__mlHook = true;

  const TAG = "multilote-hook-v1";
  const SESSION_HEADER = /^(authorization|x-[\w-]*(csrf|xsrf|token|signature|auth|session)[\w-]*)$/i;
  const DROP_HEADER = /^(content-type|content-length|accept-encoding|host|cookie|origin|referer|user-agent)$/i;
  const API_TIMEOUT_MS = 30000;
  const JSON_CAP = 100 * 1024;

  const origFetch = window.fetch;
  const taps = new Map(); // id -> { method, path: RegExp, extract, once }
  let session = { headers: {}, hasAuth: false, at: 0 };

  const post = (msg) => window.postMessage({ [TAG]: true, dir: "to-content", ...msg }, location.origin);

  // ---- sesión: cabeceras que la propia web envía a su API (solo en memoria) -------------------------------
  const noteSession = (headers) => {
    const names = Object.keys(headers);
    if (!names.some((k) => SESSION_HEADER.test(k))) return;
    const copy = {};
    for (const k of names) if (!DROP_HEADER.test(k)) copy[k] = headers[k];
    session = { headers: copy, hasAuth: true, at: Date.now() };
  };

  // ---- taps -----------------------------------------------------------------------------------------------
  const getPath = (obj, path) => String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

  const extractFrom = (spec, ctx) => {
    const out = {};
    for (const [key, rule] of Object.entries(spec || {})) {
      let v;
      try {
        if (typeof rule === "string") v = getPath(ctx.json, rule);
        else if (rule && rule.header) {
          const h = ctx.header(rule.header) || "";
          v = rule.regex ? (new RegExp(rule.regex).exec(h) || [])[rule.group || 1] : h;
        } else if (rule && rule.fromPath) v = (new RegExp(rule.fromPath).exec(ctx.path) || [])[rule.group || 1];
      } catch {}
      if (typeof v === "string" || typeof v === "number") out[key] = String(v).slice(0, 300);
    }
    return out;
  };

  // Se llama al terminar cada petición observada. Solo parsea el cuerpo si algún tap coincide.
  const onDone = async ({ method, url, status, header, readText }) => {
    for (const [id, tap] of taps) {
      if (tap.method && tap.method !== method) continue;
      if (!tap.path.test(url.pathname)) continue;
      let json;
      if (status >= 200 && status < 300 && Object.keys(tap.extract || {}).length) {
        try {
          const text = await readText();
          if (text && text.length <= JSON_CAP) json = JSON.parse(text);
        } catch {}
      }
      const extracted = status >= 200 && status < 300 ? extractFrom(tap.extract, { json, header, path: url.pathname }) : {};
      if (tap.once) taps.delete(id);
      post({ type: "tap-hit", id, status, extracted });
    }
  };

  const plainHeaders = (...sources) => {
    const out = {};
    for (const h of sources) {
      if (!h) continue;
      if (typeof Headers !== "undefined" && h instanceof Headers) h.forEach((v, k) => (out[k] = v));
      else if (Array.isArray(h)) h.forEach(([k, v]) => (out[k] = v));
      else Object.assign(out, h);
    }
    return out;
  };

  // ---- fetch ----------------------------------------------------------------------------------------------
  window.fetch = function (input, init) {
    let meta = null;
    try {
      const isReq = typeof Request !== "undefined" && input instanceof Request;
      const url = new URL(isReq ? input.url : String(input), location.href);
      if (family.test(url.hostname)) {
        const method = String((init && init.method) || (isReq ? input.method : "GET")).toUpperCase();
        noteSession(plainHeaders(isReq && input.headers, init && init.headers));
        meta = { method, url };
      }
    } catch {}
    const p = origFetch.apply(this, arguments);
    if (meta) {
      p.then((res) => {
        try {
          if (!taps.size) return; // un tap puede registrarse mientras la petición está en vuelo
          const clone = res.clone();
          onDone({ ...meta, status: res.status, header: (n) => res.headers.get(n), readText: () => clone.text() });
        } catch {}
      }, () => {});
    }
    return p;
  };

  // ---- XMLHttpRequest -------------------------------------------------------------------------------------
  const XP = XMLHttpRequest.prototype;
  const xOpen = XP.open, xSend = XP.send, xSet = XP.setRequestHeader;
  XP.open = function (method, url) {
    try {
      this.__mlx = { method: String(method).toUpperCase(), url: new URL(String(url), location.href), headers: {} };
    } catch {}
    return xOpen.apply(this, arguments);
  };
  XP.setRequestHeader = function (k, v) {
    if (this.__mlx) this.__mlx.headers[k] = v;
    return xSet.apply(this, arguments);
  };
  XP.send = function () {
    const m = this.__mlx;
    if (m && family.test(m.url.hostname)) {
      noteSession(m.headers);
      {
        this.addEventListener("loadend", () => {
          try {
            if (!taps.size) return;
            onDone({
              method: m.method,
              url: m.url,
              status: this.status,
              header: (n) => this.getResponseHeader(n),
              readText: async () => (this.responseType === "" || this.responseType === "text" ? this.responseText : JSON.stringify(this.response)),
            });
          } catch {}
        });
      }
    }
    return xSend.apply(this, arguments);
  };

  // ---- llamadas a la API en nombre de la extensión --------------------------------------------------------
  // Errores sin petición enviada ("not_sent"): no_session, host_not_allowed, bad_request. El llamante puede
  // caer a otro método sin riesgo. Errores con petición posiblemente enviada: network, timeout.
  const doApi = async (req) => {
    let url;
    try {
      url = new URL(req.url, location.href);
    } catch {
      return { error: "bad_request", sent: false };
    }
    if (url.protocol !== "https:" || !family.test(url.hostname)) return { error: "host_not_allowed", sent: false };
    const method = String(req.method || "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return { error: "bad_request", sent: false };
    if (req.requireSession !== false && !session.hasAuth) return { error: "no_session", sent: false };

    const headers = { ...session.headers, ...(req.headers || {}) };
    let body;
    try {
      const b = req.body;
      if (b && b.kind === "json") {
        body = JSON.stringify(b.value);
        if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
      } else if (b && b.kind === "form") {
        body = new FormData();
        for (const [k, v] of Object.entries(b.fields || {})) body.append(k, String(v));
        for (const f of b.files || []) {
          const blob = await (await origFetch(f.dataUrl)).blob();
          body.append(f.field, new File([blob], f.name || "foto.jpg", { type: f.type || blob.type || "image/jpeg" }));
        }
        // sin Content-Type: el navegador añade el boundary multipart
      }
    } catch {
      return { error: "bad_request", sent: false };
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
    try {
      const res = await origFetch(url.href, { method, headers, body, credentials: "include", signal: ctl.signal });
      const contentType = res.headers.get("content-type") || "";
      let json = null;
      if (/json/i.test(contentType)) {
        try {
          const text = await res.text();
          if (text.length <= JSON_CAP) json = JSON.parse(text);
        } catch {}
      }
      return { sent: true, status: res.status, ok: res.ok, contentType, location: res.headers.get("location") || null, json };
    } catch (e) {
      return { sent: true, error: ctl.signal.aborted ? "timeout" : "network", message: String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  };

  // ---- canal con el content script ------------------------------------------------------------------------
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d[TAG] !== true || d.dir !== "to-hook") return;
    if (d.cmd === "ping") post({ type: "pong", authSeen: session.hasAuth });
    else if (d.cmd === "tap" && d.id && d.spec) {
      try {
        taps.set(d.id, {
          method: d.spec.method ? String(d.spec.method).toUpperCase() : null,
          path: new RegExp(d.spec.pathSource, d.spec.flags || ""),
          extract: d.spec.extract || {},
          once: d.spec.once !== false,
        });
      } catch {}
    } else if (d.cmd === "untap") taps.delete(d.id);
    else if (d.cmd === "api" && d.reqId) {
      doApi(d.req || {}).then((result) => post({ type: "api-result", reqId: d.reqId, result }));
    }
  });

  post({ type: "pong", authSeen: false });
})();
