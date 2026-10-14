// Service worker: consume sync_queue.
//  1. cada minuto reclama tareas con la RPC claim_sync_jobs
//  2. abre la pestaña de subida del marketplace y deja que content.js rellene y publique
//  3. informa del resultado con complete_sync_job (éxito, o fallo con reintento/backoff en servidor)
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

async function startJob(job) {
  try {
    if (job.action !== "publish") throw new Error(`Acción «${job.action}» aún no soportada por la extensión`);
    const url = MULTILOTE_CONFIG.UPLOAD_URLS[job.marketplace];
    if (!url) throw new Error(`Marketplace desconocido: ${job.marketplace}`);

    const [listing] = await ML.select(`listings?id=eq.${job.listing_id}&select=*`);
    if (!listing) throw new Error("Artículo no encontrado");
    const photoUrls = await ML.signedPhotoUrls(listing.photos || []);

    const tab = await chrome.tabs.create({ url, active: false });
    const active = await getActive();
    active[tab.id] = { job, listing, photoUrls };
    await setActive(active);
  } catch (e) {
    await ML.rpc("complete_sync_job", {
      p_job_id: job.id,
      p_success: false,
      p_error: String(e.message || e),
    }).catch(() => {});
  }
}

async function finishJob(tabId, { ok, externalUrl, error }) {
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
    });
  } catch {
    /* si falla, claim_sync_jobs recupera la tarea al caducar el bloqueo */
  }
  if (ok) chrome.tabs.remove(tabId).catch(() => {});
}

// Si el usuario cierra la pestaña antes de terminar, se cuenta como fallo (el servidor reintenta).
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const active = await getActive();
  if (active[tabId]) await finishJob(tabId, { ok: false, error: "Pestaña cerrada antes de terminar" });
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
      sendResponse({ marketplace: entry.job.marketplace, listing: entry.listing, photos });
    })();
    return true;
  }
  if (msg.type === "job-result" && sender.tab) {
    finishJob(sender.tab.id, msg).then(() => sendResponse({ ok: true }));
    return true;
  }
});
