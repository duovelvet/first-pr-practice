// Utilidades de DOM compartidas por los adaptadores (content script, mundo aislado).
const MLDom = (() => {
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

  const waitForUrlChange = (from, timeout = 30000) => waitUntil(() => location.href !== from, timeout, 500).then(Boolean);

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

  const CLICKABLE = 'button, a, [role="button"], [role="menuitem"]';
  const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const findClickable = (pattern, root = document) =>
    [...root.querySelectorAll(CLICKABLE)].find((el) => isVisible(el) && pattern.test(el.textContent || ""));

  // Textos por defecto de la retirada. Los botones se localizan por TEXTO EXACTO (no por clase CSS, que cambia
  // a menudo) para no borrar otra cosa por error. Cada adaptador puede sobrescribirlos.
  const DEFAULT_DELETE = {
    deleteButton: /^\s*(eliminar|borrar)( (el )?(anuncio|art[ií]culo|producto))?\s*$/i,
    confirmButton: /^\s*((s[ií],? )?(eliminar|borrar)( (el )?(anuncio|art[ií]culo|producto))?|confirmar)\s*$/i,
    goneText: /(anuncio|art[ií]culo|producto|p[aá]gina)[^.]{0,40}(no (est[aá] disponible|existe|se (ha )?encontrado)|ya no est[aá])|error 404/i,
  };
  const DIALOG = '[role="dialog"], [role="alertdialog"], dialog[open], .modal';

  return { setNativeValue, waitFor, waitUntil, waitForUrlChange, attachPhotos, isVisible, findClickable, DEFAULT_DELETE, DIALOG };
})();
