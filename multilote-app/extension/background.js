// Service worker: consume sync_queue.
//  1. cada minuto reclama tareas con la RPC claim_sync_jobs
//  2. abre la pestaña (formulario de subida, o el anuncio a retirar) y deja que content.js actúe
//  3. informa del resultado con complete_sync_job (éxito; fallo con reintento/backoff en servidor; o fallo
//     DEFINITIVO si el resultado es ambiguo tras enviar una petición que crea algo: evita anuncios duplicados)
//
// Seguridad: los tokens de sesión de los marketplaces NUNCA pasan por aquí (se quedan en page-hook.js, dentro
// de la página). Este worker solo maneja la sesión de MultiLote (Supabase) y datos de las tareas.
importScripts("config.js", "api.js");

const ALARM = "multilote-sync";
const WORKER_ID = `ext-${chrome.runtime.id}`;

function ensureAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) runSync();
});

// Estado de tareas en curso: tabId -> { job, listing, photoUrls }. storage.session sobrevive al reinicio del worker.
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

// Resuelve la URL que hay que abrir según la acción. Lanza Error con un mensaje legible si no se puede.
// Devuelve { url, externalUrl }: externalUrl (solo en delete) es el anuncio publicado, útil para el modo API.
async function resolveJobUrl(job) {
  if (job.action === "publish") {
    const url = MULTILOTE_CONFIG.UPLOAD_URLS[job.marketplace];
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "sync-now") {
    runSync().then(sendResponse);
    return true;
  }
  if (msg.type === "get-job" && sender.tab) {
    (async () => {
      const entry = (await getActive())[sender.tab.id];
      if (!entry) return sendResponse(null);
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
