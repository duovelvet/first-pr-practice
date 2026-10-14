// Ejecutor de PLANES DE API declarativos (datos, no código): una lista de pasos HTTP con plantillas {{var}}.
// Los planes los produce lib/plan-synth.js a partir de una grabación (o se escriben a mano en un adaptador) y solo
// se usan cuando el perfil está verificado. Aquí no hay conocimiento de ningún marketplace.
//
// Plan:
//   { steps: [ Step ],
//     idempotent?: bool,               // true (p. ej. borrar): nunca se marca fallo definitivo
//     requireSession?: bool,           // por defecto true: exige haber visto cabeceras de sesión en la página
//     domVars?: { nombre: { selector, attr? } },   // valores leídos de la página (p. ej. token CSRF) -> {{nombre}}
//     urlTemplate?: string }           // URL final del anuncio, con {{var}} de lo extraído
// Step: { name, method, url, headers?, body?, expect?: [códigos], extract?, requireExtract?: [vars],
//         repeatPerPhoto?: bool,       // una petición por foto
//         collect?: { var: "ruta.json" },   // acumula en un array (p. ej. photoIds)
//         harmless?: bool }            // fallar aquí no implica que el anuncio exista (subida de fotos previa)
// Body: { kind:'json', value } | { kind:'urlencoded', fields } | { kind:'form', fields, files?: { field } }
// Extract: { var: "ruta.json" } | { var:{ json, regex, group } } | { var:{ header:'location', regex, group } }
//          | { var:{ fromUrl:{ regex, group } } }   (sobre la RUTA de la URL final tras redirecciones)
const MLApiPlan = (() => {
  const VAR = /\{\{(\w+)\}\}/g;

  function interpolate(value, ctx) {
    if (typeof value === "string") {
      const whole = /^\{\{(\w+)\}\}$/.exec(value);
      if (whole) {
        if (!(whole[1] in ctx)) throw new Error(`falta la variable ${whole[1]}`);
        return ctx[whole[1]]; // conserva el tipo (número, array…)
      }
      return value.replace(VAR, (_, k) => {
        if (!(k in ctx)) throw new Error(`falta la variable ${k}`);
        return String(ctx[k]);
      });
    }
    if (Array.isArray(value)) return value.map((v) => interpolate(v, ctx));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, ctx)]));
    }
    return value;
  }

  const getPath = (obj, path) => String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const pathname = (u) => {
    try {
      return new URL(u, "https://x.invalid").pathname;
    } catch {
      return String(u || "");
    }
  };
  const viaRegex = (text, rule) => {
    if (text == null) return undefined;
    if (!rule.regex) return text;
    try {
      return (new RegExp(rule.regex).exec(String(text)) || [])[rule.group || 1];
    } catch {
      return undefined;
    }
  };

  function extractVars(spec, res) {
    const out = {};
    for (const [key, rule] of Object.entries(spec || {})) {
      let v;
      if (typeof rule === "string") v = getPath(res.json, rule);
      else if (rule && rule.json) v = viaRegex(getPath(res.json, rule.json), rule);
      else if (rule && rule.header === "location") v = viaRegex(pathname(res.location), rule);
      else if (rule && rule.fromUrl) v = viaRegex(pathname(res.finalUrl), rule.fromUrl);
      if (typeof v === "string" || typeof v === "number") out[key] = v;
    }
    return out;
  }

  function buildRequest(step, ctx, photoGroup, plan) {
    const req = {
      method: step.method,
      url: interpolate(step.url, ctx),
      headers: interpolate(step.headers || {}, ctx),
      requireSession: plan.requireSession !== false,
    };
    const b = step.body;
    if (b && b.kind === "json") req.body = { kind: "json", value: interpolate(b.value, ctx) };
    else if (b && b.kind === "urlencoded") req.body = { kind: "urlencoded", fields: interpolate(b.fields || {}, ctx) };
    else if (b && b.kind === "form") {
      req.body = {
        kind: "form",
        fields: interpolate(b.fields || {}, ctx),
        files: b.files ? photoGroup.map((dataUrl, n) => ({ field: b.files.field, name: `foto-${n + 1}.jpg`, dataUrl })) : [],
      };
    }
    return req;
  }

  // Resultado:
  //   { ok:true, vars, externalUrl }
  //   { ok:false, fallback:true, error }   -> no se creó nada o la sesión no sirve: se puede probar por DOM
  //   { ok:false, retry:true, error }      -> rechazo limpio o limitación: reintento normal de la cola
  //   { ok:false, fatal:true, error }      -> resultado ambiguo tras enviar una petición que muta: NO reintentar
  // `kind` informa de la causa para la salud del perfil: 'unexpected' = el sitio responde distinto a lo grabado.
  async function run(plan, vars, photos, bridge, opts = {}) {
    const ctx = { ...vars };

    for (const [name, spec] of Object.entries(plan.domVars || {})) {
      const v = opts.dom ? opts.dom(spec) : null;
      if (v == null || v === "") return { ok: false, fallback: true, kind: "precondition", error: `no encuentro «${name}» en la página` };
      ctx[name] = v;
    }

    for (const [i, step] of plan.steps.entries()) {
      const mutating = step.method && step.method.toUpperCase() !== "GET";
      const groups = step.repeatPerPhoto ? photos.map((p) => [p]) : [photos];
      for (const key of Object.keys(step.collect || {})) ctx[key] = [];
      // ¿Ya se ejecutó un paso que crea/modifica de verdad (no una subida previa de fotos)? Si no, un rechazo limpio
      // significa «no se creó nada»: es seguro reintentar o probar por DOM.
      const prior = plan.steps.slice(0, i).some((s) => !s.harmless && s.method && s.method.toUpperCase() !== "GET");

      for (const group of groups) {
        let req;
        try {
          req = buildRequest(step, ctx, group, plan);
        } catch (e) {
          return { ok: false, fallback: !prior, fatal: prior && !plan.idempotent && !step.harmless, kind: "precondition", error: `plantilla: ${e.message}` };
        }

        const res = await bridge.api(req);

        if (res.error && res.sent === false) {
          return !prior
            ? { ok: false, fallback: true, kind: "precondition", error: `API no disponible (${res.error})` }
            : { ok: false, fatal: !plan.idempotent && !step.harmless, retry: plan.idempotent || step.harmless, kind: "precondition", error: `paso «${step.name}»: ${res.error}` };
        }
        if (res.error) {
          // network/timeout: la petición pudo llegar al servidor.
          return mutating && !plan.idempotent && !step.harmless
            ? { ok: false, fatal: true, kind: "ambiguous", error: `paso «${step.name}»: ${res.error} tras enviar la petición` }
            : { ok: false, retry: true, kind: "network", error: `paso «${step.name}»: ${res.error}` };
        }

        const expected = step.expect || [200, 201, 202, 204];
        if (!expected.includes(res.status)) {
          const where = `paso «${step.name}» respondió ${res.status}`;
          if (res.status === 401 || res.status === 403) {
            // Sesión/firma no válida para repetir la llamada: si aún no se creó nada, se puede probar por DOM.
            if (!prior) return { ok: false, fallback: true, kind: "auth", error: where };
            return plan.idempotent ? { ok: false, retry: true, kind: "auth", error: where } : { ok: false, fatal: true, kind: "auth", error: where };
          }
          if (res.status === 429) return { ok: false, retry: true, kind: "rate", error: `${where} (límite de peticiones)` };
          if (step.harmless || plan.idempotent) return { ok: false, retry: true, kind: res.status >= 500 ? "server" : "unexpected", error: where };
          // Rechazo limpio del servidor (validación…) sin nada creado antes: reintento normal. Un 409 o un 5xx pueden
          // significar «ya existe/se creó»: fatal.
          if (!prior && [400, 404, 405, 410, 422].includes(res.status)) return { ok: false, retry: true, kind: "unexpected", error: where };
          return { ok: false, fatal: true, kind: res.status >= 500 ? "ambiguous" : "unexpected", error: where };
        }

        Object.assign(ctx, extractVars(step.extract, res));
        for (const [key, path] of Object.entries(step.collect || {})) {
          const v = getPath(res.json, path);
          if (v !== undefined && v !== null) ctx[key].push(v);
        }
      }

      // Si la creación no devolvió lo imprescindible (el id), no sabemos qué se creó: fallo definitivo.
      for (const need of step.requireExtract || []) {
        if (!(need in ctx)) return { ok: false, fatal: !plan.idempotent, kind: "unexpected", error: `paso «${step.name}»: la respuesta no trae «${need}»` };
      }
    }

    let externalUrl = null;
    try {
      if (plan.urlTemplate) externalUrl = interpolate(plan.urlTemplate, ctx);
    } catch {
      /* creado, pero sin datos para componer la URL: se informa sin URL */
    }
    return { ok: true, vars: ctx, externalUrl };
  }

  return { run, interpolate };
})();
if (typeof module !== "undefined" && module.exports) module.exports = MLApiPlan;
