// Se ejecuta en Wallapop / Vinted / Milanuncios. Si el service worker abrió esta pestaña
// para una tarea de sync_queue, ejecuta la acción (publicar o retirar) y comunica el resultado.
// IMPORTANTE: los selectores dependen del HTML de cada marketplace y pueden cambiar.
// Ajusta SELECTORS tras inspeccionar el formulario real de cada sitio.

const SITE = location.hostname.includes("wallapop")
  ? "wallapop"
  : location.hostname.includes("vinted")
  ? "vinted"
  : location.hostname.includes("milanuncios")
  ? "milanuncios"
  : null;

const SELECTORS = {
  wallapop: {
    title: 'input[name="title"], input#title',
    description: 'textarea[name="description"], textarea#description',
    price: 'input[name="sale_price"], input#sale_price, input[name="price"]',
    photos: 'input[type="file"]',
    submit: 'button[type="submit"]',
  },
  vinted: {
    title: 'input[name="title"], input#title',
    description: 'textarea[name="description"], textarea#description',
    price: 'input[name="price"], input#price',
    photos: 'input[type="file"]',
    submit: 'button[type="submit"]',
  },
  milanuncios: {
    title: 'input[name="title"], input#title',
    description: 'textarea[name="description"], textarea#description',
    price: 'input[name="price"], input#price',
    photos: 'input[type="file"]',
    submit: 'button[type="submit"]',
  },
};

// React/Vue ignoran .value directo: hay que usar el setter nativo y disparar eventos.
function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function waitFor(selector, timeout = 20000) {
  return new Promise((resolve) => {
    const found = document.querySelector(selector);
    if (found) return resolve(found);
    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        obs.disconnect();
        resolve(el);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      obs.disconnect();
      resolve(null);
    }, timeout);
  });
}

function waitForUrlChange(from, timeout = 30000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (location.href !== from) {
        clearInterval(t);
        resolve(true);
      } else if (Date.now() - start > timeout) {
        clearInterval(t);
        resolve(false);
      }
    }, 500);
  });
}

async function attachPhotos(input, dataUrls) {
  const dt = new DataTransfer();
  for (const [i, d] of dataUrls.entries()) {
    const blob = await (await fetch(d)).blob();
    dt.items.add(new File([blob], `foto-${i + 1}.jpg`, { type: blob.type || "image/jpeg" }));
  }
  if (dt.files.length) {
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

// ---------------------------------------------------------------------------
// Retirar anuncio (action = "delete"): la pestaña ya está abierta en la URL del anuncio.
// Los botones se localizan por TEXTO EXACTO (no por clase CSS, que cambia a menudo) y solo
// se pulsan botones cuyo texto sea literalmente «Eliminar/Borrar (anuncio)», para no borrar
// otra cosa por error. Ajusta los patrones si el marketplace usa otra redacción.
// ---------------------------------------------------------------------------
const DELETE_BUTTON = /^\s*(eliminar|borrar)( (el )?(anuncio|art[ií]culo|producto))?\s*$/i;
const CONFIRM_BUTTON = /^\s*((s[ií],? )?(eliminar|borrar)( (el )?(anuncio|art[ií]culo|producto))?|confirmar)\s*$/i;
// Páginas de anuncio inexistente: si ya no está, la retirada se da por conseguida.
const GONE_TEXT = /(anuncio|art[ií]culo|producto|p[aá]gina)[^.]{0,40}(no (est[aá] disponible|existe|se (ha )?encontrado)|ya no est[aá])|error 404/i;

const CLICKABLE = 'button, a, [role="button"], [role="menuitem"]';

function isVisible(el) {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function findClickable(pattern, root = document) {
  return [...root.querySelectorAll(CLICKABLE)].find((el) => isVisible(el) && pattern.test(el.textContent || ""));
}

function waitUntil(fn, timeout, interval = 400) {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = setInterval(() => {
      const v = fn();
      if (v) {
        clearInterval(t);
        resolve(v);
      } else if (Date.now() - start > timeout) {
        clearInterval(t);
        resolve(null);
      }
    }, interval);
  });
}

async function runDelete() {
  const startUrl = location.href;
  const isGone = () => GONE_TEXT.test(document.body?.innerText || "");

  // Espera a que aparezca el botón de eliminar (o a que quede claro que el anuncio ya no existe).
  const found = await waitUntil(() => findClickable(DELETE_BUTTON) || (isGone() ? "gone" : null), 15000);
  if (found === "gone") return { ok: true, externalUrl: startUrl }; // ya estaba retirado
  if (!found) {
    throw new Error("No se encontró el botón de eliminar (¿sesión iniciada como propietario del anuncio?)");
  }

  found.click();

  // Si el marketplace pide confirmación, aparece un diálogo con otro botón de confirmar.
  const dialog = await waitUntil(() => document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open], .modal'), 4000);
  if (dialog) {
    const confirm = findClickable(CONFIRM_BUTTON, dialog);
    if (!confirm) throw new Error("No se encontró el botón de confirmación de la retirada");
    confirm.click();
  }

  // Éxito: cambia la URL, el botón desaparece o el anuncio ya no existe.
  const done = await waitUntil(
    () => location.href !== startUrl || isGone() || !document.contains(found),
    20000
  );
  if (!done) throw new Error("No se pudo confirmar la retirada del anuncio");
  return { ok: true, externalUrl: startUrl };
}

// ---------------------------------------------------------------------------
// Publicar (action = "publish")
// ---------------------------------------------------------------------------
async function runPublish(data) {
  const sel = SELECTORS[SITE];
  const titleEl = await waitFor(sel.title);
  if (!titleEl) throw new Error("No se encontró el formulario de subida (¿sesión iniciada en el marketplace?)");

  const { listing, photos } = data;
  setNativeValue(titleEl, listing.title);

  const desc = document.querySelector(sel.description);
  if (desc) setNativeValue(desc, listing.description || "");

  const price = document.querySelector(sel.price);
  if (price) setNativeValue(price, String(listing.price));

  const fileInput = document.querySelector(sel.photos);
  if (fileInput && photos.length) await attachPhotos(fileInput, photos);

  const submit = document.querySelector(sel.submit);
  if (!submit) throw new Error("No se encontró el botón de publicar (selectores por ajustar)");

  const before = location.href;
  submit.click();
  if (!(await waitForUrlChange(before))) throw new Error("No se pudo confirmar la publicación");
  return { ok: true, externalUrl: location.href };
}

(async () => {
  if (!SITE) return;
  const data = await chrome.runtime.sendMessage({ type: "get-job" }).catch(() => null);
  if (!data || data.marketplace !== SITE) return; // pestaña normal del usuario: no tocar nada

  const report = (extra) => chrome.runtime.sendMessage({ type: "job-result", ...extra });
  try {
    if (data.action === "publish") await report(await runPublish(data));
    else if (data.action === "delete") await report(await runDelete());
    else throw new Error(`Acción no soportada: ${data.action}`);
  } catch (e) {
    await report({ ok: false, error: String(e.message || e) });
  }
})();
