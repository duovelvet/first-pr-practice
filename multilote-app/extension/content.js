// Motor de ejecución en la página del marketplace (content script, mundo aislado).
// Orden de carga (manifest): lib/bridge.js, lib/dom.js, lib/api-plan.js, lib/profiles.js, adapters/*.js, content.js,
// lib/recorder.js.
//
// Si el service worker abrió esta pestaña para una tarea de sync_queue (o para la autoprueba de un perfil):
//   1. pide la tarea a background (get-job),
//   2. la ejecuta con la mejor estrategia disponible:
//        API (plan del adaptador o PERFIL VERIFICADO, con la sesión viva de la página)  ->  DOM (respaldo),
//   3. informa del resultado (job-result) con: ok, externalUrl, via, y si el fallo es definitivo (fatal).
//
// Regla de seguridad contra duplicados: si ya se envió una petición que CREA algo y el resultado es ambiguo
// (5xx, corte de red, no se pudo confirmar el clic en «publicar»), el fallo es DEFINITIVO (fatal): ni se prueba
// otra vía ni la cola reintenta, porque podría publicarse dos veces. Se queda en «error» para revisión humana.

class JobError extends Error {
  constructor(message, { code = null, fatal = false } = {}) {
    super(message);
    this.code = code;
    this.fatal = fatal;
  }
}

function assertLoggedIn(adapter) {
  if (adapter.loginPath && adapter.loginPath.test(location.pathname)) {
    throw new JobError("Sesión no iniciada en el marketplace: inicia sesión y la tarea se reintentará", { code: "needs_login" });
  }
}

// Avisa a background justo antes de enviar algo que crea/modifica datos: si luego se cierra la pestaña, sabrá que
// el resultado es ambiguo.
let announcedMutation = false;
async function announceMutation() {
  if (announcedMutation) return;
  announcedMutation = true;
  await chrome.runtime.sendMessage({ type: "job-phase", phase: "mutating" }).catch(() => {});
}

// Lee valores de la propia página que el plan necesita (p. ej. el token CSRF de un formulario).
const readDom = (spec) => {
  const el = document.querySelector(spec.selector);
  if (!el) return null;
  return spec.attr ? el.getAttribute(spec.attr) : el.textContent;
};

// Ejecuta un plan de API. Devuelve el resultado de MLApiPlan.run, o { fallback } si el modo API no está disponible.
async function tryApi(plan, vars, photos) {
  if (!(await MLBridge.whenReady())) return { ok: false, fallback: true, kind: "precondition", error: "gancho de red no disponible" };
  if (plan.requireSession !== false && !(await MLBridge.waitForSession())) {
    return { ok: false, fallback: true, kind: "precondition", error: "sin sesión detectada en la página" };
  }
  const bridge = {
    api: async (req) => {
      if (String(req.method).toUpperCase() !== "GET") await announceMutation();
      return MLBridge.api(req);
    },
  };
  return MLApiPlan.run(plan, vars, photos, bridge, { dom: readDom });
}

// Salud del perfil aprendido: informa del resultado para desactivarlo si el sitio cambia.
async function health(adapter, eff, r) {
  if (eff.source !== "profile") return;
  await MLProfiles.reportOutcome(adapter.id, !!r.ok, r.kind).catch(() => {});
}

const listingVars = (l) => ({
  title: l.title ?? "",
  description: l.description ?? "",
  price: l.price,
  priceStr: String(l.price),
  priceEs: String(l.price).replace(".", ","),
  category: l.category ?? "",
  brand: l.brand ?? "",
  size: l.size ?? "",
  condition: l.condition ?? "",
});

// ---------------------------------------------------------------------------------------------------------------
// Publicar
// ---------------------------------------------------------------------------------------------------------------
async function domPublish(adapter, data, confirm) {
  const sel = adapter.dom.publish;
  const titleEl = await MLDom.waitFor(sel.title);
  if (!titleEl) throw new JobError("No se encontró el formulario de subida (¿sesión iniciada en el marketplace?)", { code: "form_not_found" });

  const { listing, photos } = data;
  MLDom.setNativeValue(titleEl, listing.title);
  const desc = document.querySelector(sel.description);
  if (desc) MLDom.setNativeValue(desc, listing.description || "");
  const price = document.querySelector(sel.price);
  if (price) MLDom.setNativeValue(price, String(listing.price));
  const fileInput = document.querySelector(sel.photos);
  if (fileInput && photos.length) await MLDom.attachPhotos(fileInput, photos);

  const submit = document.querySelector(sel.submit);
  if (!submit) throw new JobError("No se encontró el botón de publicar (selectores por ajustar)", { code: "selector" });

  // Antes de pulsar, escuchamos la llamada de creación de la propia web: da el id/URL reales del anuncio.
  const tap = confirm && (await MLBridge.whenReady(1500)) ? MLBridge.expectTap(confirm, 30000) : null;
  const before = location.href;
  await announceMutation();
  submit.click();

  const never = new Promise(() => {});
  const winner = await Promise.race([
    tap ? tap.promise.then((r) => ({ kind: "tap", r })) : never,
    MLDom.waitForUrlChange(before, 30000).then((changed) => ({ kind: "url", changed })),
  ]);

  let hit = winner.kind === "tap" ? winner.r : null;
  if (!hit && winner.kind === "url" && winner.changed && tap) {
    // La URL cambió primero: damos un instante al tap por si trae datos más precisos.
    hit = await Promise.race([tap.promise, new Promise((r) => setTimeout(() => r(null), 1500))]);
  }
  tap?.cancel();

  if (hit && (hit.status < 200 || hit.status >= 300)) {
    // La web rechazó la creación: no se publicó nada, la cola puede reintentar.
    throw new JobError(`La web rechazó la publicación (HTTP ${hit.status})`, { code: "rejected" });
  }
  if (hit || (winner.kind === "url" && winner.changed)) {
    let externalUrl = location.href;
    try {
      if (hit && confirm.urlTemplate) externalUrl = MLApiPlan.interpolate(confirm.urlTemplate, hit.extracted);
    } catch {
      /* sin datos suficientes: nos quedamos con la URL de la pestaña */
    }
    return { ok: true, externalUrl, via: "dom" };
  }
  // Se pulsó «publicar» y no hay confirmación: pudo publicarse. No reintentar.
  throw new JobError("Se pulsó «publicar» pero no se pudo confirmar el resultado; revisa si el anuncio existe", { code: "unconfirmed", fatal: true });
}

async function publish(adapter, data) {
  assertLoggedIn(adapter);
  const eff = MLProfiles.resolve(adapter, await MLProfiles.load(adapter.id));
  // Un plan que no sabe subir fotos no sirve para un anuncio con fotos: DOM.
  const plan = eff.publish && !(eff.publish.photos === false && data.photos.length) ? eff.publish : null;
  if (plan) {
    const r = await tryApi(plan, listingVars(data.listing), data.photos);
    await health(adapter, eff, r);
    if (r.ok) return { ok: true, externalUrl: r.externalUrl, via: "api" };
    if (r.fatal) throw new JobError(r.error, { code: "api_ambiguous", fatal: true });
    if (r.retry) throw new JobError(r.error, { code: "api_retry" });
    // r.fallback: no se envió nada que cree el anuncio -> seguimos por DOM
  }
  return domPublish(adapter, data, eff.confirm);
}

// ---------------------------------------------------------------------------------------------------------------
// Retirar (idempotente: reintentar es siempre seguro)
// ---------------------------------------------------------------------------------------------------------------
async function domDelete(adapter) {
  const t = { ...MLDom.DEFAULT_DELETE, ...(adapter.dom.delete || {}) };
  const startUrl = location.href;
  const isGone = () => t.goneText.test(document.body?.innerText || "");

  // Espera al botón de eliminar (o a que quede claro que el anuncio ya no existe).
  const found = await MLDom.waitUntil(() => MLDom.findClickable(t.deleteButton) || (isGone() ? "gone" : null), 15000);
  if (found === "gone") return { ok: true, externalUrl: startUrl, via: "dom" }; // ya estaba retirado
  if (!found) throw new JobError("No se encontró el botón de eliminar (¿sesión iniciada como propietario del anuncio?)", { code: "selector" });

  found.click();

  // Si el marketplace pide confirmación, aparece un diálogo con otro botón de confirmar.
  const dialog = await MLDom.waitUntil(() => document.querySelector(MLDom.DIALOG), 4000);
  if (dialog) {
    const confirm = MLDom.findClickable(t.confirmButton, dialog);
    if (!confirm) throw new JobError("No se encontró el botón de confirmación de la retirada", { code: "selector" });
    confirm.click();
  }

  // Éxito: cambia la URL, el botón desaparece o el anuncio ya no existe.
  const done = await MLDom.waitUntil(() => location.href !== startUrl || isGone() || !document.contains(found), 20000);
  if (!done) throw new JobError("No se pudo confirmar la retirada del anuncio", { code: "unconfirmed" });
  return { ok: true, externalUrl: startUrl, via: "dom" };
}

async function retire(adapter, data) {
  assertLoggedIn(adapter);
  const eff = MLProfiles.resolve(adapter, await MLProfiles.load(adapter.id));
  const id = eff.delete && eff.idFromUrl && data.externalUrl ? eff.idFromUrl(data.externalUrl) : null;
  if (eff.delete && id) {
    const r = await tryApi({ ...eff.delete, idempotent: true }, { id, url: data.externalUrl }, []);
    await health(adapter, eff, r);
    if (r.ok) return { ok: true, externalUrl: data.externalUrl, via: "api" };
    if (r.retry || r.fatal) throw new JobError(r.error, { code: "api_retry" }); // borrar es idempotente: reintento normal
    // r.fallback -> DOM
  }
  return domDelete(adapter);
}

// ---------------------------------------------------------------------------------------------------------------
// Autoprueba de un perfil aprendido: publicar un anuncio de prueba POR API y retirarlo POR API, en dos fases
// (la retirada se hace en la página del propio anuncio, donde suelen estar el token CSRF y la sesión).
// Ignora la verificación y el consentimiento a propósito: es precisamente lo que los otorga.
// ---------------------------------------------------------------------------------------------------------------
async function selftest(adapter, data) {
  assertLoggedIn(adapter);
  const profile = await MLProfiles.load(adapter.id);
  if (!profile) throw new JobError("No hay perfil aprendido", { code: "no_profile", fatal: true });

  if (data.phase === "publish") {
    const r = await tryApi(profile.api.publish, listingVars(data.listing), data.photos);
    if (!r.ok) throw new JobError(`Autoprueba, publicar por API: ${r.error}`, { code: "selftest_publish", fatal: true });
    return { ok: true, via: "api", externalUrl: r.externalUrl, selftest: true };
  }

  const eff = MLProfiles.resolve(adapter, profile);
  const id = eff.idFromUrl && data.externalUrl ? eff.idFromUrl(data.externalUrl) : null;
  if (!id) throw new JobError("Autoprueba: no pude sacar el id del anuncio de prueba desde su URL", { code: "selftest_delete", fatal: true });
  const r = await tryApi({ ...profile.api.delete, idempotent: true }, { id, url: data.externalUrl }, []);
  if (!r.ok) throw new JobError(`Autoprueba, retirar por API: ${r.error}`, { code: "selftest_delete", fatal: true });
  return { ok: true, via: "api", selftest: true };
}

// ---------------------------------------------------------------------------------------------------------------
(async () => {
  const adapter = MLAdapters.forHost(location.hostname);
  if (!adapter) return;
  const data = await chrome.runtime.sendMessage({ type: "get-job" }).catch(() => null);
  if (!data || data.marketplace !== adapter.id) return; // pestaña normal del usuario: no tocar nada

  const report = (extra) => chrome.runtime.sendMessage({ type: "job-result", ...extra }).catch(() => {});
  try {
    if (data.action === "publish") await report(await publish(adapter, data));
    else if (data.action === "delete") await report(await retire(adapter, data));
    else if (data.action === "selftest") await report(await selftest(adapter, data));
    else throw new JobError(`Acción no soportada: ${data.action}`, { fatal: true });
  } catch (e) {
    await report({ ok: false, error: String((e && e.message) || e), code: e.code || null, fatal: !!e.fatal, selftest: data.action === "selftest" });
  }
})();
