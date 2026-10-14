// Se ejecuta en Wallapop / Vinted / Milanuncios. Si el service worker abrió esta pestaña
// para una tarea de sync_queue, rellena el formulario, publica y comunica el resultado.
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

(async () => {
  if (!SITE) return;
  const data = await chrome.runtime.sendMessage({ type: "get-job" }).catch(() => null);
  if (!data || data.marketplace !== SITE) return; // pestaña normal del usuario: no tocar nada

  const report = (ok, extra = {}) => chrome.runtime.sendMessage({ type: "job-result", ok, ...extra });
  const sel = SELECTORS[SITE];

  try {
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

    await report(true, { externalUrl: location.href });
  } catch (e) {
    await report(false, { error: String(e.message || e) });
  }
})();
