// Service worker: consume sync_queue.
//  1. cada minuto reclama tareas con la RPC claim_sync_jobs
//  2. abre la pestaña (formulario de subida, o el anuncio a retirar) y deja que content.js actúe
//  3. informa del resultado con complete_sync_job (éxito; fallo con reintento/backoff en servidor; o fallo
//     DEFINITIVO si el resultado es ambiguo tras enviar una petición que crea algo: evita anuncios duplicados)
//
// Además gestiona el APRENDIZAJE de endpoints (sin tocar la consola del navegador):
//  · grabar:   el usuario hace a mano «subir y borrar un anuncio de prueba» con valores centinela; el gancho y el
//              content script mandan aquí las peticiones; al terminar, lib/plan-synth.js deduce el perfil.
//  · verificar: autoprueba de publicar + retirar por API; solo si pasa, el perfil queda «verified».
//
// Seguridad: los tokens de sesión de los marketplaces NUNCA pasan por aquí (se quedan en page-hook.js, dentro
// de la página). Este worker solo maneja la sesión de MultiLote (Supabase) y datos de las tareas/perfiles.
importScripts("config.js", "api.js", "lib/plan-synth.js", "lib/profiles.js");

const ALARM = "multilote-sync";
const WORKER_ID = `ext-${chrome.runtime.id}`;
// JPEG mínimo para la autoprueba cuando el usuario no tiene ninguna foto en MultiLote.
const TINY_JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

function ensureAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) runSync();
});

// Estado de tareas en curso: tabId -> { job, listing, photoUrls, externalUrl, mutating, selftest?… }.
// storage.session sobrevive al reinicio del worker.
async function getActive() {
  const { active } = await chrome.storage.session.get("active");
  return active || {};
}
async function setActive(active) {
  await chrome.storage.session.set({ active });
}

async function setBadge(text) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: "#2158cc" });
}

let running = false;
async function runSync() {
  if (running) return { claimed: 0 };
  running = true;
  try {
    if (!(await ML.getSession())) return { claimed: 0, error: "no-session" };
    const jobs = await ML.rpc("claim_sync_jobs", { p_limit: 3, p_worker: WORKER_ID });
    for (const job of jobs) await startJob(job);
    await setBadge(jobs.length ? String(jobs.length) : "");
    return { claimed: jobs.length };
  } catch (e) {
    return { claimed: 0, error: String(e.message || e) };
  } finally {
    running = false;
  }
}

function isAllowedUrl(marketplace, url) {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      (MULTILOTE_CONFIG.ALLOWED_HOSTS[marketplace] || []).some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))
    );
  } catch {
    return false;
  }
}

// URL del formulario de subida: la aprendida en la grabación (si hay perfil y es del dominio permitido) o la de config.js.
async function uploadUrlFor(marketplace) {
  const profile = await MLProfiles.load(marketplace);
  if (profile && profile.uploadUrl && isAllowedUrl(marketplace, profile.uploadUrl)) return profile.uploadUrl;
  return MULTILOTE_CONFIG.UPLOAD_URLS[marketplace] || null;
}

// Resuelve la URL que hay que abrir según la acción. Lanza Error con un mensaje legible si no se puede.
// Devuelve { url, externalUrl }: externalUrl (solo en delete) es el anuncio publicado, útil para el modo API.
async function resolveJobUrl(job) {
  if (job.action === "publish") {
    const url = await uploadUrlFor(job.marketplace);
    if (!url) throw new Error(`Marketplace desconocido: ${job.marketplace}`);
    return { url, externalUrl: null };
  }
  if (job.action === "delete") {
    const [pub] = await ML.select(
      `publications?listing_id=eq.${job.listing_id}&marketplace=eq.${job.marketplace}&select=external_url`
    );
    if (!pub?.external_url) {
      throw new Error("No hay URL del anuncio guardada: retíralo a mano en el marketplace");
    }
    if (!isAllowedUrl(job.marketplace, pub.external_url)) {
      throw new Error("URL del anuncio no válida para este marketplace");
    }
    return { url: pub.external_url, externalUrl: pub.external_url };
  }
  throw new Error(`Acción «${job.action}» aún no soportada por la extensión`);
}

async function startJob(job) {
  try {
    const { url, externalUrl } = await resolveJobUrl(job);

    let listing = null;
    let photoUrls = [];
    if (job.action === "publish") {
      [listing] = await ML.select(`listings?id=eq.${job.listing_id}&select=*`);
      if (!listing) throw new Error("Artículo no encontrado");
      photoUrls = await ML.signedPhotoUrls(listing.photos || []);
    }

    const tab = await chrome.tabs.create({ url, active: false });
    const active = await getActive();
    active[tab.id] = { job, listing, photoUrls, externalUrl, mutating: false };
    await setActive(active);
  } catch (e) {
    await ML.rpc("complete_sync_job", {
      p_job_id: job.id,
      p_success: false,
      p_error: String(e.message || e),
    }).catch(() => {});
  }
}

// Registro corto de resultados (para el popup): permite ver qué hizo la extensión sin mirarla.
async function logRun(entry, result) {
  const { runs = [] } = await chrome.storage.local.get("runs");
  runs.unshift({
    t: Date.now(),
    marketplace: entry.job.marketplace,
    action: entry.job.action,
    ok: !!result.ok,
    via: result.via || null,
    fatal: !!result.fatal,
    error: result.ok ? null : String(result.error || "").slice(0, 200),
  });
  await chrome.storage.local.set({ runs: runs.slice(0, 20) });
}

async function finishJob(tabId, result) {
  const { ok, externalUrl, error, fatal, code } = result;
  const active = await getActive();
  const entry = active[tabId];
  if (!entry) return;
  if (entry.selftest) return finishSelftest(tabId, entry, result);
  delete active[tabId];
  await setActive(active);
  try {
    await ML.rpc("complete_sync_job", {
      p_job_id: entry.job.id,
      p_success: !!ok,
      p_external_url: externalUrl || null,
      p_error: ok ? null : error || "Error desconocido",
      p_fatal: !ok && !!fatal,
    });
  } catch {
    /* si falla, claim_sync_jobs recupera la tarea al caducar el bloqueo */
  }
  await logRun(entry, result).catch(() => {});
  // Sin sesión en el marketplace no hay nada que hacer hasta que el usuario inicie sesión: avisamos.
  if (!ok && code === "needs_login") {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    await chrome.action.setTitle({ title: `MultiLote: inicia sesión en ${entry.job.marketplace} para continuar` });
  }
  if (ok) chrome.tabs.remove(tabId).catch(() => {});
}

// Si el usuario cierra la pestaña antes de terminar, se cuenta como fallo. Si era una publicación que ya había
// empezado a modificar (fase «mutating»), el resultado es ambiguo y el fallo es definitivo (evita duplicados).
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const entry = (await getActive())[tabId];
  if (!entry) return;
  if (entry.selftest) {
    const active = await getActive();
    delete active[tabId];
    await setActive(active);
    await recordSelftest(entry.marketplace, { ok: false, error: "Pestaña cerrada durante la autoprueba", orphan: entry.phase === "delete", url: entry.externalUrl || null });
    return;
  }
  const ambiguous = entry.job.action === "publish" && entry.mutating;
  await finishJob(tabId, {
    ok: false,
    fatal: ambiguous,
    error: ambiguous
      ? "Pestaña cerrada después de enviar la publicación: revisa si el anuncio existe"
      : "Pestaña cerrada antes de terminar",
  });
});

async function toDataUrl(url) {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// ===============================================================================================================
// Aprendizaje: grabar -> sintetizar -> (popup) verificar
// ===============================================================================================================
let recChain = Promise.resolve();
const serial = (fn) => (recChain = recChain.then(fn, fn)); // lecturas-modificaciones de la grabación, en orden

async function startRecording(marketplace) {
  const url = MULTILOTE_CONFIG.UPLOAD_URLS[marketplace];
  if (!url) throw new Error(`Marketplace desconocido: ${marketplace}`);
  const n = Math.floor(1000 + Math.random() * 9000);
  const marker = `MLTEST-${n}`;
  const sentinels = { marker, title: marker, description: `${marker} descripcion de prueba`, price: "7.77" };
  await chrome.storage.session.set({ rec: { marketplace, sentinels, startedAt: Date.now() }, recCalls: [], recUrls: [] });
  await chrome.tabs.create({ url, active: true });
  return { sentinels };
}

async function stopRecording() {
  return serial(async () => {
    const { rec, recCalls = [], recUrls = [] } = await chrome.storage.session.get(["rec", "recCalls", "recUrls"]);
    if (!rec) throw new Error("No hay ninguna grabación en curso");
    const r = MLSynth.synthesize({ marketplace: rec.marketplace, calls: recCalls, urls: recUrls, sentinels: rec.sentinels });
    await chrome.storage.session.remove(["rec", "recCalls", "recUrls"]);
    if (!r.ok) return { ok: false, error: r.error, report: r.report, calls: recCalls.length };
    await MLProfiles.update(rec.marketplace, () => MLProfiles.finalize({ ...r.profile, warnings: r.report.warnings }));
    return { ok: true, report: r.report, calls: recCalls.length };
  });
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  serial(async () => {
    const { rec, recUrls = [] } = await chrome.storage.session.get(["rec", "recUrls"]);
    if (!rec || !isAllowedUrl(rec.marketplace, info.url)) return;
    if (recUrls.length && recUrls[recUrls.length - 1].url === info.url) return;
    recUrls.push({ t: Date.now(), url: info.url });
    await chrome.storage.session.set({ recUrls });
  });
});

function addRecCall(call) {
  return serial(async () => {
    const { rec, recCalls = [] } = await chrome.storage.session.get(["rec", "recCalls"]);
    if (!rec || recCalls.length >= 300) return;
    recCalls.push({ ...call, t: call.t || Date.now() });
    await chrome.storage.session.set({ recCalls });
  });
}

// ---- autoprueba (verificación) ---------------------------------------------------------------------------------
async function latestPhotoDataUrl() {
  try {
    const rows = await ML.select("listings?status=eq.active&photos=neq.%7B%7D&order=created_at.desc&limit=1&select=photos");
    const path = rows?.[0]?.photos?.[0];
    if (!path) return null;
    const [url] = await ML.signedPhotoUrls([path]);
    return url ? await toDataUrl(url) : null;
  } catch {
    return null;
  }
}

async function recordSelftest(marketplace, result) {
  await MLProfiles.update(marketplace, (p) => {
    if (!p) return p;
    const next = { ...p, lastSelftest: { ...result, at: Date.now() } };
    if (result.ok) {
      next.status = "verified";
      next.verifiedHash = p.hash;
      next.verifiedAt = Date.now();
      next.health = { failures: 0, lastOkAt: Date.now() };
      delete next.staleReason;
    }
    return next;
  });
}

async function startSelftest(marketplace) {
  const profile = await MLProfiles.load(marketplace);
  if (!profile || !profile.api.publish || !profile.api.delete) {
    throw new Error("El perfil no tiene plan de publicar y de retirar: vuelve a aprender grabando también el borrado");
  }
  const n = Math.floor(1000 + Math.random() * 9000);
  const listing = { title: `MLTEST-${n}`, description: `MLTEST-${n} anuncio de autoprueba, se borra solo`, price: 7.77, category: "", brand: "", size: "", condition: "" };
  const photoDataUrls = profile.api.publish.photos ? [(await latestPhotoDataUrl()) || TINY_JPEG] : [];
  const tab = await chrome.tabs.create({ url: (await uploadUrlFor(marketplace)) || MULTILOTE_CONFIG.UPLOAD_URLS[marketplace], active: false });
  const active = await getActive();
  active[tab.id] = { selftest: true, phase: "publish", marketplace, listing, photoDataUrls, job: { id: "selftest", action: "selftest", marketplace }, mutating: false };
  await setActive(active);
  return { started: true };
}

async function finishSelftest(tabId, entry, r) {
  const active = await getActive();
  const mk = entry.marketplace;
  if (entry.phase === "publish") {
    if (r.ok && r.externalUrl) {
      // Fase 2: la retirada se hace en la página del propio anuncio (token CSRF, sesión…).
      entry.phase = "delete";
      entry.externalUrl = r.externalUrl;
      active[tabId] = entry;
      await setActive(active);
      await chrome.tabs.update(tabId, { url: r.externalUrl });
      return;
    }
    delete active[tabId];
    await setActive(active);
    await recordSelftest(mk, {
      ok: false,
      orphan: !!r.ok,
      error: r.ok ? "Se publicó el anuncio de prueba pero no se pudo componer su URL para borrarlo: bórralo a mano." : r.error,
    });
    chrome.tabs.remove(tabId).catch(() => {});
    return;
  }
  delete active[tabId];
  await setActive(active);
  if (r.ok) await recordSelftest(mk, { ok: true });
  else await recordSelftest(mk, { ok: false, orphan: true, url: entry.externalUrl, error: r.error });
  chrome.tabs.remove(tabId).catch(() => {});
}

// ===============================================================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => p.then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));

  if (msg.type === "sync-now") {
    runSync().then(sendResponse);
    return true;
  }

  // ---- desde el popup: aprendizaje ----
  if (msg.type === "rec-start") return reply(startRecording(msg.marketplace)), true;
  if (msg.type === "rec-stop") return reply(stopRecording()), true;
  if (msg.type === "selftest-start") return reply(startSelftest(msg.marketplace)), true;
  if (msg.type === "profiles-get") {
    reply(
      (async () => ({
        profiles: await MLProfiles.all(),
        rec: (await chrome.storage.session.get("rec")).rec || null,
      }))()
    );
    return true;
  }
  if (msg.type === "profile-consent") {
    reply(MLProfiles.update(msg.marketplace, (p) => (p ? { ...p, consent: { ...(p.consent || {}), baked: !!msg.baked } } : p)).then(() => ({ ok: true })));
    return true;
  }
  if (msg.type === "profile-delete") {
    reply(MLProfiles.update(msg.marketplace, () => null).then(() => ({ ok: true })));
    return true;
  }

  // ---- desde content scripts ----
  if (msg.type === "rec-state") {
    (async () => {
      const { rec } = await chrome.storage.session.get("rec");
      sendResponse({ active: !!rec, marketplace: rec?.marketplace || null });
    })();
    return true;
  }
  if (msg.type === "rec-call" && sender.tab) {
    addRecCall(msg.call).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "get-job" && sender.tab) {
    (async () => {
      const entry = (await getActive())[sender.tab.id];
      if (!entry) return sendResponse(null);
      if (entry.selftest) {
        return sendResponse({
          action: "selftest",
          phase: entry.phase,
          marketplace: entry.marketplace,
          listing: entry.listing,
          photos: entry.photoDataUrls || [],
          externalUrl: entry.externalUrl || null,
        });
      }
      const photos = [];
      for (const u of entry.photoUrls) {
        try {
          photos.push(await toDataUrl(u));
        } catch {
          /* foto omitida */
        }
      }
      sendResponse({
        action: entry.job.action,
        marketplace: entry.job.marketplace,
        listing: entry.listing,
        photos,
        externalUrl: entry.externalUrl || null,
      });
    })();
    return true;
  }
  if (msg.type === "job-phase" && sender.tab) {
    // El content script avisa justo antes de enviar algo que crea/modifica datos en el marketplace.
    (async () => {
      const active = await getActive();
      if (active[sender.tab.id] && msg.phase === "mutating") {
        active[sender.tab.id].mutating = true;
        await setActive(active);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.type === "job-result" && sender.tab) {
    finishJob(sender.tab.id, msg).then(() => sendResponse({ ok: true }));
    return true;
  }
});
