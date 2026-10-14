// Perfiles aprendidos por marketplace (service worker y content scripts). Un perfil es JSON puro en chrome.storage.local:
//   { v, marketplace, status: 'draft'|'verified'|'stale', confirm, idFromUrl, api:{publish,delete}, hash, verifiedHash,
//     consent:{baked}, health:{failures}, lastSelftest, learnedAt, verifiedAt }
// No contiene tokens ni cookies. «verified» significa: la autoprueba (publicar + retirar por API) pasó con ESTE plan
// (hash) en esta instalación. No se hereda de ningún sitio: se gana o no hay modo API.
const MLProfiles = (() => {
  const KEY = "profiles";
  const MAX_FAILURES = 2; // fallos «inesperados» seguidos antes de desactivar el modo API

  const fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(36);
  };
  const finalize = (profile) => ({ ...profile, hash: fnv(JSON.stringify(profile.api)) });
  const isVerified = (p) => !!p && p.status === "verified" && !!p.hash && p.verifiedHash === p.hash;

  async function all() {
    const { profiles = {} } = await chrome.storage.local.get(KEY);
    return profiles;
  }
  const load = async (id) => (await all())[id] || null;

  // Lectura-modificación-escritura serializada (varias pestañas pueden informar a la vez).
  let chain = Promise.resolve();
  function update(id, fn) {
    const run = async () => {
      const profiles = await all();
      const next = fn(profiles[id] || null);
      if (next) profiles[id] = next;
      else delete profiles[id];
      await chrome.storage.local.set({ [KEY]: profiles });
      return next;
    };
    chain = chain.then(run, run);
    return chain;
  }

  const toRegex = (spec) => new RegExp(spec.source, spec.flags || "");

  // Lo que usa el motor para un marketplace: adaptador (código del repo) + perfil aprendido.
  //  · confirm / idFromUrl: se usan desde que hay perfil (solo observan o leen: bajo riesgo).
  //  · publish / delete por API: solo con perfil VERIFICADO (o api.verified en el adaptador del repo).
  //  · publicar por API además exige consentimiento si el plan arrastra constantes del anuncio de prueba.
  function resolve(adapter, profile) {
    const out = { confirm: adapter.confirm, idFromUrl: adapter.idFromUrl, publish: null, delete: null, source: "dom" };
    if (adapter.api && adapter.api.verified) {
      out.publish = adapter.api.publish;
      out.delete = adapter.api.delete;
      out.source = "adapter";
    }
    if (!profile) return out;
    if (!out.confirm && profile.confirm) {
      out.confirm = { method: profile.confirm.method, path: toRegex(profile.confirm.path), extract: profile.confirm.extract, urlTemplate: profile.confirm.urlTemplate };
    }
    if (!out.idFromUrl && profile.idFromUrl) {
      out.idFromUrl = (url) => {
        try {
          const m = new RegExp(profile.idFromUrl.regex).exec(new URL(url).pathname);
          return m ? m[profile.idFromUrl.group || 1] : null;
        } catch {
          return null;
        }
      };
    }
    if (out.source === "dom" && isVerified(profile)) {
      const pub = profile.api.publish;
      if (pub && (!(pub.bakedFields || []).length || (profile.consent && profile.consent.baked))) out.publish = pub;
      out.delete = profile.api.delete;
      out.source = "profile";
    }
    return out;
  }

  // Salud: el sitio responde distinto a lo aprendido (4xx inesperado, respuesta sin id, 5xx tras crear) -> tras
  // MAX_FAILURES seguidos el perfil pasa a «stale» y todo vuelve al DOM hasta volver a aprender/verificar.
  const COUNTS = new Set(["unexpected", "ambiguous"]);
  const reportOutcome = (id, ok, kind) =>
    update(id, (p) => {
      if (!p) return p;
      const health = { failures: 0, ...(p.health || {}) };
      if (ok) {
        health.failures = 0;
        health.lastOkAt = Date.now();
      } else if (COUNTS.has(kind)) {
        health.failures += 1;
        if (health.failures >= MAX_FAILURES && p.status === "verified") {
          return { ...p, health, status: "stale", staleReason: `El sitio respondió distinto a lo aprendido ${health.failures} veces seguidas` };
        }
      }
      return { ...p, health };
    });

  return { all, load, update, finalize, isVerified, resolve, reportOutcome };
})();
