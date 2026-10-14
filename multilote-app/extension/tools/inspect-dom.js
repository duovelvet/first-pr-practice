// Herramienta de desarrollo (NO forma parte de la extensión). Ayuda a ajustar la extensión a un
// marketplace sin copiar HTML ni peticiones en bruto. Hace dos cosas a la vez:
//   1. Registra las peticiones POST/PUT/PATCH/DELETE que dispara la propia página (fetch, XHR, sendBeacon):
//      URL, método, NOMBRES de cabeceras y forma (claves/tipos) de los cuerpos enviados y recibidos.
//   2. Resume los controles del DOM actual (campos, botones, diálogos).
//
// Uso: abre Wallapop con tu sesión, F12 → Console → pega TODO este archivo → Enter.
//      Después haz tu prueba a mano (subir y borrar un producto de prueba) SIN recargar la página
//      (si se recarga, vuelve a pegar el script: el registro se conserva en esta pestaña).
//      Al terminar, escribe  dump()  en la consola. Copia el resultado al portapapeles; pégalo en el chat.
//
// Otras funciones: mlGet(true) registra también los GET propios del sitio · mlClear() borra el registro ·
//                  mlHelp() recuerda esto · dump({dom:false}) omite el resumen del DOM.
//
// PRIVACIDAD — lo que NO sale nunca: valores de tokens, cookies, cabecera Authorization (solo se indica
// "Bearer <redacted>"), ni valores de claves tipo email/teléfono/dirección/lat/lon/nombre/contraseña.
// Los IDs (uuid, números largos, ids tipo hash) se sustituyen por etiquetas estables ID#1, ID#2…, de modo
// que se ve QUÉ id devuelto al crear es el que luego aparece en la URL del DELETE, sin revelar el id real.
// Los textos libres se resumen como <string len=N>. Los archivos solo muestran tipo y tamaño.
// Límites: no ve peticiones de Web Workers/Service Workers ni cabeceras que añade el navegador (Cookie,
// Origin, User-Agent…). Del tráfico a terceros (CDN de imágenes, analítica) solo se registran subidas de
// ficheros/binarios, y de ellas únicamente host + ruta + nombres de parámetros.
(() => {
  if (window.__mlInspect) {
    console.log("El inspector ya estaba instalado. Usa dump(), mlClear(), mlGet(true), mlHelp().");
    return;
  }
  const _copy = typeof copy === "function" ? copy : null; // helper de la consola: hay que capturarlo ahora
  const FIRST_PARTY = /(^|\.)wallapop\.(com|net|es)$/i;
  const STORE_KEY = "__ml_inspect_v1";
  const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  const state = { includeGet: false, log: [], seq: 0, ids: new Map() };

  // ---- persistencia (solo datos ya anonimizados; los ids se guardan como hash, nunca en claro) --------------
  try {
    const s = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
    if (s) Object.assign(state, { log: s.log || [], seq: s.seq || 0, ids: new Map(s.ids || []) });
  } catch {}
  const persist = () => {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({ log: state.log.slice(-250), seq: state.seq, ids: [...state.ids] }));
    } catch {}
  };

  // ---- anonimización ---------------------------------------------------------------------------------------
  const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
  const SENSITIVE_KEY = /pass(word)?|token|secret|authoriz|cookie|session|auth|key$|^key|signature|jwt|bearer|e-?mail|phone|tel(efono)?|mobile|address|direc|street|zip|postal|lat(itude)?$|^lon(g|gitude)?$|^lng$|location|coordinat|name|surname|nif|dni|iban|card/i;
  const SENSITIVE_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|mpid)$|token|secret|signature|session|device-?id|api-?key|csrf|xsrf/i;
  const TIMEY_KEY = /time|date|(^|_)at$|ts$|stamp|expire/i;

  const fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(36) + ":" + s.length;
  };
  const idLabel = (raw) => {
    const k = fnv(String(raw));
    if (!state.ids.has(k)) state.ids.set(k, "ID#" + (state.ids.size + 1));
    return state.ids.get(k);
  };
  const idLike = (s) => UUID.test(s) || /^\d{7,}$/.test(s) || (/^[a-z0-9]{10,20}$/.test(s) && /\d/.test(s) && /[a-z]/.test(s));
  // Sustituye ids dentro de rutas/slugs: uuids completos y trozos tipo id separados por - _ / .
  const labelIds = (text) =>
    String(text)
      .replace(UUID_G, (m) => idLabel(m))
      .split(/([-_/.=&?])/)
      .map((t) => (idLike(t) ? idLabel(t) : t))
      .join("");

  const strValue = (key, s, force) => {
    if (force || SENSITIVE_KEY.test(key)) return `<redacted string len=${s.length}>`;
    if (JWT.test(s) || /^[A-Za-z0-9+/_=-]{40,}$/.test(s)) return `<token len=${s.length}>`;
    if (idLike(s)) return idLabel(s);
    if (/^https?:\/\//i.test(s)) {
      try {
        const u = new URL(s);
        return `<url ${u.hostname}${labelIds(u.pathname)}>`;
      } catch {
        return `<url len=${s.length}>`;
      }
    }
    if (s.length <= 40 && /^[\w\-.:/+]+$/.test(s)) return labelIds(s); // tipo enum: "EUR", "used", "100" (o slug corto)
    if (s.length <= 120 && /^[a-z0-9\-_/]+$/.test(s)) return labelIds(s); // slug largo
    return `<string len=${s.length}>`;
  };

  const shape = (v, key = "", depth = 0, force = false) => {
    const sens = force || SENSITIVE_KEY.test(key);
    if (v === null || v === undefined) return null;
    if (typeof v === "boolean") return sens ? "<redacted bool>" : v;
    if (typeof v === "number") {
      if (sens) return "<redacted number>";
      if (Number.isInteger(v) && Math.abs(v) >= 1e7 && !TIMEY_KEY.test(key)) return idLabel(v);
      return v;
    }
    if (typeof v === "string") return strValue(key, v, force);
    if (depth > 6) return Array.isArray(v) ? "<array>" : "<object>";
    if (Array.isArray(v)) {
      if (!v.length) return [];
      return v.length === 1 ? [shape(v[0], key, depth + 1, sens)] : [shape(v[0], key, depth + 1, sens), `…+${v.length - 1} más`];
    }
    const out = {};
    for (const k of Object.keys(v).slice(0, 60)) out[k] = shape(v[k], k, depth + 1, sens);
    return out;
  };

  const headerSummary = (h) => {
    const out = {};
    for (const [k0, v0] of Object.entries(h)) {
      const k = k0.toLowerCase();
      const v = String(v0);
      if (k === "authorization") out[k] = `${(v.match(/^(\w+)\s/) || [, "?"])[1]} <redacted len=${v.length}>`;
      else if (SENSITIVE_HEADER.test(k)) out[k] = `<redacted len=${v.length}>`;
      else out[k] = UUID.test(v) ? "<uuid>" : JWT.test(v) || v.length > 60 ? `<value len=${v.length}>` : v;
    }
    return out;
  };

  const urlInfo = (url) => {
    const first = FIRST_PARTY.test(url.hostname);
    const query = {};
    for (const [k, v] of url.searchParams) query[k] = first ? strValue(k, v, false) : "<omitido>";
    return { host: url.hostname, first_party: first, path: labelIds(url.pathname), query };
  };

  // ---- cuerpos ---------------------------------------------------------------------------------------------
  // Devuelve { kind, shape, binary } ; binary = true si es fichero/binario (para el filtro de terceros).
  const bodyInfo = (body, contentType = "") => {
    if (body === null || body === undefined) return null;
    if (typeof body === "string") {
      try {
        return { kind: "json", shape: shape(JSON.parse(body)) };
      } catch {}
      if (/x-www-form-urlencoded/i.test(contentType)) return bodyInfo(new URLSearchParams(body));
      return { kind: "text", len: body.length };
    }
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const o = {};
      let binary = false;
      for (const [k, v] of body.entries()) {
        const val = typeof v === "string" ? strValue(k, v, false) : ((binary = true), { file: true, type: v.type, size: v.size });
        o[k] = k in o ? [].concat(o[k], val) : val;
      }
      return { kind: "formdata", shape: o, binary };
    }
    if (body instanceof URLSearchParams) {
      const o = {};
      for (const [k, v] of body.entries()) o[k] = strValue(k, v, false);
      return { kind: "urlencoded", shape: o };
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) return { kind: "blob", type: body.type, size: body.size, binary: true };
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { kind: "binary", bytes: body.byteLength, binary: true };
    return { kind: "stream-or-other" };
  };

  const textInfo = (text, contentType) => {
    if (/json/i.test(contentType)) {
      try {
        return { kind: "json", shape: shape(JSON.parse(text)) };
      } catch {}
    }
    return { kind: contentType || "unknown", len: text.length };
  };

  // ---- registro --------------------------------------------------------------------------------------------
  const wanted = (method, url, binaryBody) => {
    if (!/^https?:$/.test(url.protocol)) return false;
    const first = FIRST_PARTY.test(url.hostname);
    if (MUTATING.has(method)) return first || binaryBody; // terceros: solo subidas de ficheros
    return state.includeGet && method === "GET" && first && !/\.(js|css|png|jpe?g|webp|svg|gif|ico|woff2?|map)$/i.test(url.pathname);
  };

  const commit = (e) => {
    state.log.push(e);
    if (state.log.length > 400) state.log.shift();
    persist();
    console.log(`%c[ML #${e.n}]`, "color:#2158cc;font-weight:bold", e.method, e.host + e.path, "→", e.status ?? e.error ?? "…");
  };

  const begin = (via, method, url, headers, body, contentType) => {
    const b = bodyInfo(body, contentType);
    if (!wanted(method, url, !!(b && b.binary))) return null;
    const h = headerSummary(headers);
    return {
      n: ++state.seq,
      t: new Date().toISOString(),
      via,
      method,
      ...urlInfo(url),
      req_headers: h,
      uses_bearer: /^bearer/i.test(headers.authorization || headers.Authorization || ""),
      req_body: b ? { ...b, binary: undefined } : null,
      _t0: performance.now(),
    };
  };

  const finish = (e, extra) => {
    e.ms = Math.round(performance.now() - e._t0);
    delete e._t0;
    Object.assign(e, extra);
    commit(e);
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
  const ci = (obj, name) => obj[Object.keys(obj).find((k) => k.toLowerCase() === name) || ""] || "";

  // ---- fetch -----------------------------------------------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let entry = null;
    let reqClone = null;
    try {
      const isReq = typeof Request !== "undefined" && input instanceof Request;
      const method = String((init && init.method) || (isReq ? input.method : "GET")).toUpperCase();
      const url = new URL(isReq ? input.url : String(input), location.href);
      const headers = plainHeaders(isReq && input.headers, init && init.headers);
      let body = init && init.body;
      if ((body === undefined || body === null) && isReq && MUTATING.has(method)) reqClone = input.clone();
      entry = begin("fetch", method, url, headers, body, ci(headers, "content-type"));
      if (entry) entry.credentials = (init && init.credentials) || (isReq && input.credentials) || "same-origin(default)";
      if (entry && reqClone) {
        // Request con cuerpo propio: lo leemos del clon, sin tocar el original.
        reqClone.text().then((txt) => (entry.req_body = textInfo(txt, ci(headers, "content-type")))).catch(() => {});
      }
    } catch {}
    const p = origFetch.apply(this, arguments);
    if (!entry) return p;
    return p.then(
      (res) => {
        try {
          const ct = res.headers.get("content-type") || "";
          const base = {
            status: res.status,
            res_content_type: ct,
            res_header_names: [...res.headers.keys()],
            res_location: res.headers.get("location") ? labelIds(res.headers.get("location")) : undefined,
          };
          if (/json|text|urlencoded/i.test(ct)) {
            res.clone().text().then(
              (txt) => finish(entry, { ...base, res_body: txt ? textInfo(txt, ct) : null }),
              () => finish(entry, base)
            );
          } else finish(entry, { ...base, res_body: { kind: ct || "none", bytes: Number(res.headers.get("content-length")) || undefined } });
        } catch {
          finish(entry, {});
        }
        return res;
      },
      (err) => {
        finish(entry, { error: String((err && err.message) || err) });
        throw err;
      }
    );
  };

  // ---- XMLHttpRequest --------------------------------------------------------------------------------------
  const XP = XMLHttpRequest.prototype;
  const xOpen = XP.open, xSend = XP.send, xSet = XP.setRequestHeader;
  XP.open = function (method, url) {
    try {
      this.__ml = { method: String(method).toUpperCase(), url: new URL(String(url), location.href), headers: {} };
    } catch {}
    return xOpen.apply(this, arguments);
  };
  XP.setRequestHeader = function (k, v) {
    if (this.__ml) this.__ml.headers[k] = v;
    return xSet.apply(this, arguments);
  };
  XP.send = function (body) {
    const m = this.__ml;
    if (m) {
      try {
        const entry = begin("xhr", m.method, m.url, m.headers, body, ci(m.headers, "content-type"));
        if (entry) {
          entry.credentials = this.withCredentials ? "include" : "same-origin(default)";
          this.addEventListener("loadend", () => {
            try {
              const ct = this.getResponseHeader("content-type") || "";
              const base = {
                status: this.status || undefined,
                res_content_type: ct,
                res_header_names: (this.getAllResponseHeaders() || "").trim().split(/\r?\n/).map((l) => l.split(":")[0].toLowerCase()).filter(Boolean),
              };
              let res_body = null;
              if (this.responseType === "" || this.responseType === "text") res_body = this.responseText ? textInfo(this.responseText, ct) : null;
              else if (this.responseType === "json") res_body = { kind: "json", shape: shape(this.response) };
              else res_body = { kind: this.responseType };
              finish(entry, { ...base, res_body, error: this.status === 0 ? "red/abortada" : undefined });
            } catch {
              finish(entry, {});
            }
          });
        }
      } catch {}
    }
    return xSend.apply(this, arguments);
  };

  // ---- sendBeacon ------------------------------------------------------------------------------------------
  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => {
      try {
        const e = begin("beacon", "POST", new URL(String(url), location.href), {}, data, "");
        if (e) finish(e, {});
      } catch {}
      return origBeacon(url, data);
    };
  }

  // ---- resumen del DOM -------------------------------------------------------------------------------------
  const redact = (t) =>
    (t || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
      .replace(/\d[\d\s().-]{7,}\d/g, "[num]")
      .slice(0, 60);
  const cleanUrl = (u) => {
    try {
      const x = new URL(u, location.href);
      return x.origin + x.pathname;
    } catch {
      return "";
    }
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const TEST_ATTRS = ["data-testid", "data-test", "data-cy", "data-qa", "data-test-id"];
  const path = (el) => {
    const parts = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 4 && n !== document.body; n = n.parentElement, i++) {
      const tid = TEST_ATTRS.map((a) => n.getAttribute(a)).find(Boolean);
      let part = n.tagName.toLowerCase();
      if (n.id && !/\d{4,}|[:]/.test(n.id)) part += `#${n.id}`;
      else if (tid) part += `[data-testid="${tid}"]`;
      else if (n.getAttribute("role")) part += `[role="${n.getAttribute("role")}"]`;
      parts.unshift(part);
      if (n.id || tid) break;
    }
    return parts.join(" > ");
  };
  const describe = (el) => {
    const out = { tag: el.tagName.toLowerCase(), visible: visible(el), path: path(el) };
    for (const a of ["type", "name", "id", "role", "aria-label", "placeholder", "accept", "inputmode", "autocomplete", "aria-haspopup", "aria-expanded", "aria-checked", "maxlength"]) {
      const v = el.getAttribute(a);
      if (v) out[a] = redact(v);
    }
    for (const a of TEST_ATTRS) if (el.getAttribute(a)) out[a] = el.getAttribute(a);
    if (el.disabled) out.disabled = true;
    if (el.multiple) out.multiple = true;
    if (el.required) out.required = true;
    const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lab) out.label = redact(lab.textContent);
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) out.labelledby = redact(labelled.split(" ").map((i) => document.getElementById(i)?.textContent || "").join(" "));
    if (!/^(input|textarea|select)$/.test(out.tag)) out.text = redact(el.textContent);
    if (out.tag === "select") out.options = [...el.options].slice(0, 12).map((o) => redact(o.textContent));
    if (out.tag === "a") out.href = cleanUrl(el.getAttribute("href"));
    return out;
  };
  const CONTROLS =
    'input, textarea, select, button, [role="button"], [role="menuitem"], [role="option"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [contenteditable="true"]';
  const ACTION_LINK = /eliminar|borrar|editar|vender|publicar|subir|vendid|mis (productos|anuncios)|desactivar|reservar/i;

  const domSummary = () => {
    const items = [...document.querySelectorAll(CONTROLS)].map(describe);
    for (const a of document.querySelectorAll("a[href]")) {
      if (ACTION_LINK.test(a.textContent || "") || a.closest('[role="dialog"], [role="menu"]')) items.push(describe(a));
    }
    const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open], [role="menu"], [aria-modal="true"]')]
      .filter(visible)
      .map((d) => ({ path: path(d), role: d.getAttribute("role"), text: redact((d.innerText || "").slice(0, 200)) }));
    return {
      url: cleanUrl(location.href),
      title: redact(document.title),
      headings: [...document.querySelectorAll("h1, h2")].filter(visible).slice(0, 8).map((h) => redact(h.textContent)),
      file_inputs: [...document.querySelectorAll('input[type="file"]')].map(describe),
      open_dialogs_or_menus: dialogs,
      controls: items,
    };
  };

  // ---- dump() ----------------------------------------------------------------------------------------------
  const build = (opts = {}) => {
    const endpoints = {};
    for (const e of state.log) {
      const k = `${e.method} ${e.host}${e.path}`;
      endpoints[k] = (endpoints[k] || 0) + 1;
    }
    return {
      captured_at: new Date().toISOString(),
      page_url: cleanUrl(location.href),
      api_summary: endpoints,
      auth_hints: {
        // Solo NOMBRES: dónde parece vivir la sesión. Las cookies HttpOnly no son visibles desde JS.
        cookie_names_visible_to_js: document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter(Boolean),
        localStorage_keys: Object.keys(localStorage).slice(0, 60),
        sessionStorage_keys: Object.keys(sessionStorage).filter((k) => k !== STORE_KEY).slice(0, 60),
      },
      api_calls: state.log,
      dom: opts.dom === false ? undefined : domSummary(),
    };
  };

  const toClipboard = (text) => {
    if (_copy) {
      try {
        _copy(text);
        return true;
      } catch {}
    }
    try {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  };

  window.dump = (opts) => {
    const json = JSON.stringify(build(opts), null, 1);
    window.__mlLast = json;
    const kb = (json.length / 1024).toFixed(1);
    if (toClipboard(json)) console.log(`✔ Copiado al portapapeles: ${state.log.length} llamadas API + resumen del DOM (${kb} KB). Pégalo en el chat.`);
    else console.log(`No pude copiar automáticamente (${kb} KB). Ejecuta:  copy(__mlLast)`);
    return { llamadas: state.log.length, kb: Number(kb) };
  };
  window.mlClear = () => {
    state.log = [];
    state.seq = 0;
    persist();
    console.log("Registro de llamadas borrado.");
  };
  window.mlGet = (on = true) => {
    state.includeGet = !!on;
    console.log(`Registro de GET propios del sitio: ${state.includeGet ? "ACTIVADO" : "desactivado"}`);
  };
  window.mlHelp = () =>
    console.log(
      "Haz tu prueba a mano (subir y borrar un producto) sin recargar. Luego:  dump()  → copia todo al portapapeles.\n" +
        "mlGet(true) también registra GET propios (útil para ver cómo lista «mis productos») · mlClear() borra el registro."
    );
  window.__mlInspect = true;
  console.log("✔ Inspector instalado: registrando POST/PUT/PATCH/DELETE. Haz tu prueba y escribe  dump()");
})();
