// Sintetizador de perfiles de API a partir de una GRABACIÓN (función pura: sin DOM ni chrome.*).
//
// Entrada: las peticiones que hizo la web mientras el usuario subía y borraba un anuncio de prueba con valores
// «centinela» conocidos (título MLTEST-1234, precio 7.77…). Como sabemos qué valores escribió, podemos ver en qué
// campo del cuerpo viaja cada uno y convertirlo en plantilla ({{title}}, {{price}}…), sin adivinar nada.
//
// Salida: un perfil serializable { confirm, idFromUrl, api: { publish, delete } } + un informe con lo deducido,
// lo que es constante copiada del anuncio de prueba ("bakedFields") y las advertencias.
//
// Formato de cada llamada grabada:
//   { kind: 'xhr'|'nav', t, method, url, hasSession,
//     req: { type: 'json'|'urlencoded'|'multipart'|'none', json?, fields?, hidden?: [nombres], files?: [{field,type,size}] },
//     res?: { status, location?, finalUrl?, json? } }          // res solo en 'xhr'; en 'nav' el destino sale de `urls`
// `urls`: [{ t, url }] navegaciones del marketplace durante la grabación.
const MLSynth = (() => {
  const ID_TOKEN = /^(?=.*\d)[A-Za-z0-9_-]{5,}$/;
  const CSRF_NAME = /csrf|xsrf|authenticity|nonce|^_?token$/i;
  const PERSONAL_KEY = /lat|lon|lng|location|address|direc|postal|zip|phone|tel|mail|name|surname|dni|nif/i;
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

  // ---- utilidades -----------------------------------------------------------------------------------------
  const leaves = (v, path = [], out = []) => {
    if (v === null || v === undefined) return out;
    if (typeof v === "object") {
      for (const k of Object.keys(v)) leaves(v[k], [...path, k], out);
      return out;
    }
    out.push({ path, value: v });
    return out;
  };
  const pstr = (path) => path.join(".");
  const pathOf = (u) => {
    try {
      return new URL(u, "https://x.invalid").pathname;
    } catch {
      return String(u);
    }
  };

  const callStrings = (call) => {
    const out = [call.url];
    const r = call.req || {};
    if (r.json !== undefined) for (const l of leaves(r.json)) out.push(String(l.value));
    if (r.fields) for (const v of Object.values(r.fields)) [].concat(v).forEach((x) => out.push(String(x)));
    return out;
  };
  const mentions = (call, token) => callStrings(call).some((s) => s.includes(token));

  // Posibles identificadores dentro de una cadena (segmentos de ruta y trozos separados por - _ . =).
  const tokensOf = (s) => {
    const out = new Set();
    const isPath = /^https?:\/\//.test(s) || s.startsWith("/");
    const base = isPath ? pathOf(s) : s;
    for (const seg of base.split("/")) {
      if (!seg) continue;
      out.add(seg);
      for (const t of seg.split(/[-_.=]/)) out.add(t);
    }
    out.add(s);
    return [...out].filter((t) => ID_TOKEN.test(t));
  };

  // Regex (sobre una RUTA) que captura `value` dentro de `url`, generalizando el «slug» que lo acompaña.
  function pathRegex(url, value) {
    const p = pathOf(url);
    const i = p.indexOf(value);
    if (i < 0) return null;
    const before = p.slice(0, i);
    const after = p.slice(i + value.length);
    const segStart = before.lastIndexOf("/") + 1;
    const segBefore = before.slice(segStart);
    const head = "^" + esc(before.slice(0, segStart));
    const tail = after === "" || after === "/" ? "/?$" : esc(after);
    let rx;
    if (segBefore === "") rx = `${head}([^/?#]+)${tail}`;
    else if (/[-_]$/.test(segBefore)) rx = `${head}[^/]*[-_]([^/?#_-]+)${tail}`;
    else return null;
    try {
      const m = new RegExp(rx).exec(p);
      return m && m[1] === value ? rx : null;
    } catch {
      return null;
    }
  }

  // Regex sobre un TEXTO (p. ej. un slug) para extraer `value` cuando va como sufijo/prefijo tras un separador.
  function tokenRegex(str, value) {
    const i = str.indexOf(value);
    if (i < 0) return null;
    const before = str.slice(0, i);
    const after = str.slice(i + value.length);
    let rx = null;
    if (after === "" && /[-_]$/.test(before)) rx = `${esc(before.slice(-1))}([^${esc(before.slice(-1))}/]+)$`;
    else if (before === "" && /^[-_]/.test(after)) rx = `^([^${esc(after[0])}/]+)${esc(after[0])}`;
    if (!rx) return null;
    const m = new RegExp(rx).exec(str);
    return m && m[1] === value ? rx : null;
  }

  // ---- plantillas -----------------------------------------------------------------------------------------
  function makeTemplater(info) {
    const baked = [];
    const priceNum = Number(info.price);
    const priceStr = String(info.price);
    const priceEs = priceStr.replace(".", ",");
    const domVars = {};

    const bake = (path, value) => {
      const p = pstr(path);
      let shown = value;
      if (PERSONAL_KEY.test(p)) shown = "<oculto>";
      else if (typeof value === "string" && value.length > 40) shown = `<texto ${value.length}>`;
      baked.push({ path: p, value: shown });
    };

    const scalar = (v, path) => {
      if (typeof v === "string") {
        if (v === info.title) return "{{title}}";
        if (info.description && v === info.description) return "{{description}}";
        if (v === priceStr) return "{{priceStr}}";
        if (v === priceEs) return "{{priceEs}}";
        if (info.idValue && v.includes(info.idValue)) return v.split(info.idValue).join("{{id}}");
        if (v !== "") bake(path, v);
        return v;
      }
      if (typeof v === "number") {
        if (v === priceNum) return "{{price}}";
        bake(path, v);
        return v;
      }
      if (typeof v === "boolean") {
        bake(path, v);
        return v;
      }
      return v;
    };

    const json = (v, path = []) => {
      if (Array.isArray(v)) {
        const ids = info.photoIds;
        if (ids && ids.length && v.length === ids.length && v.every((x, i) => x === ids[i])) return "{{photoIds}}";
        return v.map((x, i) => json(x, [...path, i]));
      }
      if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).map((k) => [k, json(v[k], [...path, k])]));
      return scalar(v, path);
    };

    const fields = (f, hidden = []) => {
      const out = {};
      for (const [name, val] of Object.entries(f || {})) {
        if (hidden.includes(name) && CSRF_NAME.test(name)) {
          out[name] = "{{csrf}}";
          domVars.csrf = { selector: `input[name="${name}"]`, attr: "value" };
        } else out[name] = [].concat(val).length > 1 ? [].concat(val).map((x) => scalar(x, [name])) : scalar([].concat(val)[0], [name]);
      }
      return out;
    };

    return { json, fields, baked, domVars, scalar };
  }

  const bodyFor = (req, T, fileField) => {
    if (!req || req.type === "none") return undefined;
    if (req.type === "json") return { kind: "json", value: T.json(req.json) };
    if (req.type === "urlencoded") return { kind: "urlencoded", fields: T.fields(req.fields, req.hidden) };
    if (req.type === "multipart") {
      const b = { kind: "form", fields: T.fields(req.fields, req.hidden) };
      if (req.files && req.files.length) b.files = { field: fileField || req.files[0].field };
      return b;
    }
    return undefined;
  };

  // ---- síntesis -------------------------------------------------------------------------------------------
  function synthesize({ marketplace, calls, urls = [], sentinels }) {
    const warnings = [];
    const fail = (code, message) => ({ ok: false, error: { code, message }, report: { warnings } });
    const sorted = [...calls].sort((a, b) => a.t - b.t);
    const marker = sentinels.marker;

    // 1) Petición de creación: la primera que contiene el título centinela.
    const mutating = sorted.filter((c) => c.method !== "GET");
    const create = mutating.find((c) => mentions(c, marker));
    if (!create) return fail("no_create", "No vi ninguna petición de creación con el título de prueba. ¿Escribiste exactamente el título indicado y publicaste?");

    // 2) Destino tras crear (URL pública del anuncio).
    const resultUrl = (urls.filter((u) => u.t > create.t).sort((a, b) => a.t - b.t)[0] || {}).url || null;

    // 2b) Página del formulario de subida: la última URL visitada antes de crear (donde estaba el usuario al publicar).
    const uploadUrl = ([...urls].filter((u) => u.t <= create.t).sort((a, b) => b.t - a.t)[0] || {}).url || null;

    // 3) Identificador del anuncio: el trozo de la respuesta de creación que luego aparece en una petición posterior.
    const later = mutating.filter((c) => c.t > create.t && !mentions(c, marker));
    const cands = new Set();
    for (const l of leaves(create.res && create.res.json)) tokensOf(String(l.value)).forEach((t) => cands.add(t));
    if (create.res && create.res.location) tokensOf(create.res.location).forEach((t) => cands.add(t));
    if (resultUrl) tokensOf(resultUrl).forEach((t) => cands.add(t));
    const idValue = [...cands].sort((a, b) => b.length - a.length).find((t) => later.some((c) => mentions(c, t))) || null;

    let del = null;
    if (idValue) {
      const withId = later.filter((c) => mentions(c, idValue));
      del = withId.filter((c) => c.method === "DELETE").pop() || withId.filter((c) => /delet|remov|elimin|borr|baja/i.test(c.url)).pop() || withId.pop() || null;
    } else {
      warnings.push("No encontré el identificador del anuncio en una petición posterior: no se puede sintetizar la retirada. ¿Borraste el anuncio de prueba?");
    }

    // 4) Cómo extraer el id (y el slug) de la respuesta de creación.
    const extract = {};
    const fromJson = (value) => {
      const ls = leaves(create.res && create.res.json);
      const exact = ls.find((l) => String(l.value) === value);
      if (exact) return pstr(exact.path);
      const within = ls.find((l) => typeof l.value === "string" && l.value.includes(value) && tokenRegex(l.value, value));
      return within ? { json: pstr(within.path), regex: tokenRegex(within.value, value), group: 1 } : null;
    };
    let slugPath = null;
    if (idValue) {
      let rule = create.kind === "xhr" ? fromJson(idValue) : null;
      if (!rule && create.res && create.res.location && pathRegex(create.res.location, idValue)) {
        rule = { header: "location", regex: pathRegex(create.res.location, idValue), group: 1 };
      }
      if (!rule && resultUrl && pathRegex(resultUrl, idValue)) rule = { fromUrl: { regex: pathRegex(resultUrl, idValue), group: 1 } };
      if (rule) extract.id = rule;
      else warnings.push("No supe de dónde sacar el id en la respuesta de creación.");

      // slug: texto de la respuesta que contiene el id y que aparece en la URL pública
      if (create.kind === "xhr" && resultUrl) {
        const s = leaves(create.res && create.res.json).find((l) => typeof l.value === "string" && l.value.includes(idValue) && l.value !== idValue && resultUrl.includes(l.value));
        if (s) {
          slugPath = pstr(s.path);
          extract.slug = slugPath;
        }
      }
    }

    // 5) URL pública (plantilla) e idFromUrl (id a partir de la URL guardada del anuncio).
    let urlTemplate = null;
    let idFromUrl = null;
    if (resultUrl && idValue) {
      if (slugPath) {
        const slugVal = leaves(create.res.json).find((l) => pstr(l.path) === slugPath).value;
        urlTemplate = resultUrl.split(slugVal).join("{{slug}}");
      } else if (pathOf(resultUrl).split("/").includes(idValue)) {
        urlTemplate = resultUrl.split(idValue).join("{{id}}");
      } else warnings.push("La URL pública del anuncio lleva texto que no se puede reproducir: el anuncio se guardará sin enlace.");
      const rx = pathRegex(resultUrl, idValue);
      if (rx) idFromUrl = { regex: rx, group: 1 };
      else warnings.push("No pude deducir cómo sacar el id de la URL del anuncio: la retirada por API queda desactivada.");
    } else if (!resultUrl) warnings.push("No vi ninguna navegación al anuncio publicado: el anuncio se guardará sin enlace.");

    // 6) Fotos: llamadas multipart con fichero anteriores a la creación, cuyo id viaja luego en el cuerpo de creación.
    const photoCalls = mutating.filter((c) => c.t < create.t && c.kind === "xhr" && c.req && c.req.type === "multipart" && c.req.files && c.req.files.length);
    let photoStep = null;
    let photoIds = null;
    let photosSupported = false;
    const createStrings = new Set(callStrings(create));
    if (create.req && create.req.type === "multipart" && create.req.files && create.req.files.length) photosSupported = true;
    else if (photoCalls.length) {
      const pc = photoCalls[0];
      const idLeaf = leaves(pc.res && pc.res.json).find((l) => createStrings.has(String(l.value)));
      if (idLeaf) {
        photoIds = photoCalls.map((c) => {
          const l = leaves(c.res && c.res.json).find((x) => pstr(x.path) === pstr(idLeaf.path));
          return l ? String(l.value) : null;
        });
        if (photoIds.includes(null)) photoIds = null;
        else {
          photoStep = { pc, path: pstr(idLeaf.path) };
          photosSupported = true;
        }
      }
      if (!photosSupported) warnings.push("Subiste una foto pero no vi cómo se enlaza con el anuncio: los anuncios con fotos se publicarán por DOM.");
    } else warnings.push("El anuncio de prueba no tenía fotos: los anuncios con fotos se publicarán por DOM.");

    // 7) Plantillas de la creación.
    const info = { title: sentinels.title, description: sentinels.description, price: sentinels.price, photoIds, idValue: null };
    const T = makeTemplater(info);
    const createBody = bodyFor(create.req, T);
    const createStep = {
      name: "crear",
      method: create.method,
      url: create.url,
      ...(createBody ? { body: createBody } : {}),
      ...(Object.keys(extract).length ? { extract } : {}),
      ...(extract.id ? { requireExtract: ["id"] } : {}),
    };
    const steps = [];
    if (photoStep) {
      const PT = makeTemplater({ title: null, description: null, price: NaN, idValue: null });
      const pb = bodyFor(photoStep.pc.req, PT);
      steps.push({
        name: "foto",
        method: photoStep.pc.method,
        url: photoStep.pc.url,
        body: pb,
        repeatPerPhoto: true,
        harmless: true,
        collect: { photoIds: photoStep.path },
      });
      T.baked.push(...PT.baked.map((b) => ({ ...b, path: `foto.${b.path}` })));
      Object.assign(T.domVars, PT.domVars);
    }
    steps.push(createStep);

    const anySession = [create, ...(photoStep ? [photoStep.pc] : [])].some((c) => c.hasSession);
    const publish = {
      requireSession: anySession,
      photos: photosSupported,
      urlTemplate,
      ...(Object.keys(T.domVars).length ? { domVars: T.domVars } : {}),
      bakedFields: T.baked,
      steps,
    };

    // 8) Retirada.
    let deletePlan = null;
    if (del && idValue && idFromUrl) {
      const DT = makeTemplater({ title: null, description: null, price: NaN, idValue });
      const url = del.url.split(idValue).join("{{id}}");
      const body = bodyFor(del.req, DT);
      deletePlan = {
        idempotent: true,
        requireSession: !!del.hasSession,
        ...(Object.keys(DT.domVars).length ? { domVars: DT.domVars } : {}),
        steps: [{ name: "borrar", method: del.method, url, ...(body ? { body } : {}), expect: [200, 204, 404] }],
      };
    } else if (idValue && !del) warnings.push("No identifiqué la petición de borrado.");

    // 9) Tap de confirmación para el modo DOM (solo si la creación fue una llamada XHR/fetch).
    let confirm = null;
    if (create.kind === "xhr") {
      confirm = {
        method: create.method,
        path: { source: "^" + esc(pathOf(create.url)) + "/?$", flags: "" },
        extract,
        urlTemplate,
      };
    }

    const profile = {
      v: 1,
      marketplace,
      learnedAt: new Date().toISOString(),
      status: "draft",
      uploadUrl,
      confirm,
      idFromUrl,
      api: { publish, delete: deletePlan },
      consent: { baked: false },
      health: { failures: 0 },
    };
    return {
      ok: true,
      profile,
      report: {
        warnings,
        created: { method: create.method, url: create.url, via: create.kind },
        deleted: del ? { method: del.method, url: del.url } : null,
        bakedFields: T.baked,
        photos: photosSupported,
      },
    };
  }

  return { synthesize };
})();
if (typeof module !== "undefined" && module.exports) module.exports = MLSynth;
