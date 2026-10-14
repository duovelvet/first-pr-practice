// Rellena el formulario de subida del marketplace con el artículo elegido en el popup.
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
  },
  vinted: {
    title: 'input[name="title"], input#title',
    description: 'textarea[name="description"], textarea#description',
    price: 'input[name="price"], input#price',
    photos: 'input[type="file"]',
  },
  milanuncios: {
    title: 'input[name="title"], input#title',
    description: 'textarea[name="description"], textarea#description',
    price: 'input[name="price"], input#price',
    photos: 'input[type="file"]',
  },
};

// React/Vue ignoran .value directo: hay que usar el setter nativo y disparar eventos.
function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function waitFor(selector, timeout = 15000) {
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

async function attachPhotos(input, urls) {
  const dt = new DataTransfer();
  for (const [i, url] of urls.entries()) {
    try {
      const blob = await (await fetch(url)).blob();
      dt.items.add(new File([blob], `foto-${i + 1}.jpg`, { type: blob.type || "image/jpeg" }));
    } catch {
      /* foto omitida */
    }
  }
  if (dt.files.length) {
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function banner(text) {
  const div = document.createElement("div");
  div.textContent = text;
  Object.assign(div.style, {
    position: "fixed", top: "12px", right: "12px", zIndex: 2147483647, background: "#1b46a3",
    color: "#fff", padding: "10px 14px", borderRadius: "8px", font: "14px system-ui", boxShadow: "0 4px 12px rgba(0,0,0,.25)",
  });
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 8000);
}

(async () => {
  if (!SITE) return;
  const { pending } = await chrome.storage.local.get("pending");
  // Caduca a los 10 min para no rellenar formularios por error más tarde.
  if (!pending || pending.marketplace !== SITE || Date.now() - pending.at > 10 * 60 * 1000) return;

  const sel = SELECTORS[SITE];
  const titleEl = await waitFor(sel.title);
  if (!titleEl) return; // no estamos en la página de subida

  const { listing, photoUrls } = pending;
  setNativeValue(titleEl, listing.title);

  const desc = document.querySelector(sel.description);
  if (desc) setNativeValue(desc, listing.description || "");

  const price = document.querySelector(sel.price);
  if (price) setNativeValue(price, String(listing.price));

  const fileInput = document.querySelector(sel.photos);
  if (fileInput && photoUrls.length) await attachPhotos(fileInput, photoUrls);

  await chrome.storage.local.remove("pending");
  banner("MultiLote ha rellenado el formulario. Revisa los datos y publica.");
})();
