// Ejecutor de PLANES DE API declarativos (datos, no código): una lista de pasos HTTP con plantillas {{var}}.
// Los planes viven en cada adaptador y se activan solo cuando están verificados contra tráfico real
// (api.verified = true). Aquí no hay conocimiento de ningún marketplace.
//
// Plan:
//   { steps: [ { name, method, url, headers?, body?, expect?, extract? } ],
//     idempotent?: bool,          // true (p. ej. DELETE): nunca se marca fallo definitivo
//     urlTemplate?: string }      // URL final del anuncio, con {{var}} de lo extraído
// Body: { kind:'json', value:<objeto con plantillas> } | { kind:'form', fields:{...}, files:{ field, from:'photos' } }
// Extract: { var: "ruta.json" } | { var:{ header:'location', regex:'...', group:1 } }
const MLApiPlan = (() => {
  const VAR = /\{\{(\w+)\}\}/g;

  function interpolate(value, ctx) {
    if (typeof value === "string") {
      const whole = /^\{\{(\w+)\}\}$/.exec(value);
      if (whole) {
        if (!(whole[1] in ctx)) throw new Error(`falta la variable ${whole[1]}`);
        return ctx[whole[1]]; // conserva el tipo (número, etc.)
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

  function extractVars(spec, res) {
    const out = {};
    for (const [key, rule] of Object.entries(spec || {})) {
      let v;
      if (typeof rule === "string") v = getPath(res.json, rule);
      else if (rule && rule.header === "location") {
        v = rule.regex ? (new RegExp(rule.regex).exec(res.location || "") || [])[rule.group || 1] : res.location;
      }
      if (typeof v === "string" || typeof v === "number") out[key] = v;
    }
    return out;
  }

  // Resultado:
  //   { ok:true, vars, externalUrl }
  //   { ok:false, fallback:true, error }       -> no se creó nada o la sesión no sirve: se puede probar por DOM
  //   { ok:false, retry:true, error }          -> rechazo limpio o limitación: reintento normal de la cola
  //   { ok:false, fatal:true, error }          -> resultado ambiguo tras enviar una petición que muta: NO reintentar
  async function run(plan, vars, photos, bridge) {
    const ctx = { ...vars };
    for (const [i, step] of plan.steps.entries()) {
      const mutating = step.method && step.method.toUpperCase() !== "GET";
      let req;
      try {
        req = {
          method: step.method,
          url: interpolate(step.url, ctx),
          headers: interpolate(step.headers || {}, ctx),
          requireSession: plan.requireSession !== false,
        };
        if (step.body && step.body.kind === "json") req.body = { kind: "json", value: interpolate(step.body.value, ctx) };
        else if (step.body && step.body.kind === "form") {
          req.body = {
            kind: "form",
            fields: interpolate(step.body.fields || {}, ctx),
            files: step.body.files
              ? photos.map((dataUrl, n) => ({ field: step.body.files.field, name: `foto-${n + 1}.jpg`, dataUrl }))
              : [],
          };
        }
      } catch (e) {
        return { ok: false, fallback: i === 0, fatal: i > 0 && !plan.idempotent, error: `plantilla: ${e.message}` };
      }

      const res = await bridge.api(req);

      if (res.error && res.sent === false) {
        // No salió nada. Si ya habíamos creado algo en pasos previos, el estado es ambiguo.
        return i === 0
          ? { ok: false, fallback: true, error: `API no disponible (${res.error})` }
          : { ok: false, fatal: !plan.idempotent, error: `paso «${step.name}»: ${res.error}` };
      }
      if (res.error) {
        // network/timeout: la petición pudo llegar al servidor.
        return mutating && !plan.idempotent
          ? { ok: false, fatal: true, error: `paso «${step.name}»: ${res.error} tras enviar la petición` }
          : { ok: false, retry: true, error: `paso «${step.name}»: ${res.error}` };
      }

      const expected = step.expect || [200, 201, 202, 204];
      if (expected.includes(res.status)) {
        Object.assign(ctx, extractVars(step.extract, res));
        continue;
      }

      const where = `paso «${step.name}» respondió ${res.status}`;
      if (i === 0 && (res.status === 401 || res.status === 403)) return { ok: false, fallback: true, error: where };
      if (res.status === 429) return { ok: false, retry: true, error: `${where} (límite de peticiones)` };
      if (i === 0 && [400, 404, 422].includes(res.status)) return { ok: false, retry: true, error: where };
      if (plan.idempotent && res.status < 500) return { ok: false, retry: true, error: where };
      return { ok: false, fatal: !plan.idempotent, retry: plan.idempotent, error: where };
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
