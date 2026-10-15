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
  let recording = false; // modo aprendizaje: se activa desde el popup (ver lib/recorder.js)
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


  // ---- grabación (modo aprendizaje) -----------------------------------------------------------------------
  // Solo corre mientras el usuario graba. Se anonimizan los SECRETOS (tokens, contraseñas…) pero no los datos
  // del anuncio de prueba: el sintetizador los necesita para ver en qué campo viaja cada valor centinela.
  const SECRET_KEY = /pass(word)?|secret|token|authoriz|cookie|session|jwt|bearer/i;
  const scrub = (v, key = "") => {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map((x) => scrub(x, key));
    if (typeof v === "object") return Object.fromEntries(Object.keys(v).slice(0, 80).map((k) => [k, scrub(v[k], k)]));
    return SECRET_KEY.test(key) ? "<redacted>" : v;
  };
  const addField = (acc, k, v) => {
    acc[k] = k in acc ? [].concat(acc[k], v) : v;
  };
  const snapshotBody = (body, contentType) => {
    if (body == null) return { type: "none" };
    if (typeof body === "string") {
      try {
        return { type: "json", json: scrub(JSON.parse(body)) };
      } catch {}
      if (/urlencoded/i.test(contentType || "") || /^[^=&\s]+=/.test(body)) return snapshotBody(new URLSearchParams(body));
      return { type: "none", kind: "string", len: body.length, ct: String(contentType || "").slice(0, 60) };
    }
    if (body instanceof URLSearchParams) {
      const f = {};
      for (const [k, v] of body.entries()) addField(f, k, SECRET_KEY.test(k) ? "<redacted>" : v);
      return { type: "urlencoded", fields: f };
    }
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const f = {};
      const files = [];
      for (const [k, v] of body.entries()) {
        if (typeof v === "string") addField(f, k, SECRET_KEY.test(k) ? "<redacted>" : v);
        else files.push({ field: k, type: v.type, size: v.size });
      }
      return { type: "multipart", fields: f, files };
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) return { type: "multipart", fields: {}, files: [{ field: "file", type: body.type, size: body.size }] };
    return { type: "none", kind: (body && body.constructor && body.constructor.name) || typeof body };
  };
  const hasSessionHeader = (headers) => Object.keys(headers).some((k) => SESSION_HEADER.test(k));
  const recordCall = (meta, reqSnap, hasSession, res) => {
    post({
      type: "rec-call",
      call: { kind: "xhr", t: meta.t0, method: meta.method, url: meta.url.href, hasSession, req: reqSnap, res },
    });
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
    let rec = null;
    try {
      const isReq = typeof Request !== "undefined" && input instanceof Request;
      const url = new URL(isReq ? input.url : String(input), location.href);
      if (family.test(url.hostname)) {
        const method = String((init && init.method) || (isReq ? input.method : "GET")).toUpperCase();
        const headers = plainHeaders(isReq && input.headers, init && init.headers);
        noteSession(headers);
        meta = { method, url, t0: Date.now() };
        if (recording && method !== "GET") {
          const ct = Object.keys(headers).find((k) => k.toLowerCase() === "content-type");
          rec = { req: snapshotBody(init && init.body, ct ? headers[ct] : ""), hasSession: hasSessionHeader(headers) };
        }
      }
    } catch {}
    const p = origFetch.apply(this, arguments);
    if (meta) {
      p.then((res) => {
        try {
          if (rec) {
            const ct = res.headers.get("content-type") || "";
            const clone = res.clone();
            (/json/i.test(ct) ? clone.text() : Promise.resolve("")).then((text) => {
              let json;
              try {
                if (text && text.length <= JSON_CAP) json = scrub(JSON.parse(text));
              } catch {}
              recordCall(meta, rec.req, rec.hasSession, { status: res.status, location: res.headers.get("location") || undefined, finalUrl: res.url || undefined, json });
            });
          }
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
  XP.send = function (body) {
    const m = this.__mlx;
    if (m && family.test(m.url.hostname)) {
      noteSession(m.headers);
      let rec = null;
      if (recording && m.method !== "GET") {
        const ctKey = Object.keys(m.headers).find((k) => k.toLowerCase() === "content-type");
        rec = { t0: Date.now(), req: snapshotBody(body, ctKey ? m.headers[ctKey] : ""), hasSession: hasSessionHeader(m.headers) };
      }
      this.addEventListener("loadend", () => {
        try {
          if (rec) {
            const ct = this.getResponseHeader("content-type") || "";
            let json;
            try {
              if (/json/i.test(ct) && (this.responseType === "" || this.responseType === "text") && this.responseText.length <= JSON_CAP) json = scrub(JSON.parse(this.responseText));
            } catch {}
            recordCall({ ...m, t0: rec.t0 }, rec.req, rec.hasSession, { status: this.status, location: this.getResponseHeader("location") || undefined, finalUrl: this.responseURL || undefined, json });
          }
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
      } else if (b && b.kind === "urlencoded") {
        body = new URLSearchParams();
        for (const [k, v] of Object.entries(b.fields || {})) [].concat(v).forEach((x) => body.append(k, String(x)));
      } else if (b && b.kind === "form") {
        body = new FormData();
        for (const [k, v] of Object.entries(b.fields || {})) [].concat(v).forEach((x) => body.append(k, String(x)));
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
      return { sent: true, status: res.status, ok: res.ok, contentType, location: res.headers.get("location") || null, finalUrl: res.url || null, redirected: !!res.redirected, json };
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
    else if (d.cmd === "rec") recording = !!d.on;
    else if (d.cmd === "api" && d.reqId) {
      doApi(d.req || {}).then((result) => post({ type: "api-result", reqId: d.reqId, result }));
    }
  });

  post({ type: "pong", authSeen: false });
})();
