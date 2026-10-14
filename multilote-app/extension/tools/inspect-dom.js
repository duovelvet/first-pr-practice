// Herramienta de desarrollo (NO forma parte de la extensión): resume los controles de una página
// para ajustar selectores sin copiar HTML entero ni datos personales.
//
// Uso: abre la página en Chrome (con tu sesión), F12 → pestaña Console → pega TODO este archivo → Enter.
// El resultado se copia al portapapeles (y se imprime). Pégalo en el chat.
//
// Privacidad: NO incluye valores de campos, cookies ni tokens. Los textos se recortan a 60 caracteres,
// y se tachan correos y números largos (teléfonos). Las URLs van sin parámetros ni hash.
(() => {
  const redact = (t) =>
    (t || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
      .replace(/\d[\d\s().-]{7,}\d/g, "[num]")
      .slice(0, 60);

  const cleanUrl = (u) => {
    try {
      const x = new URL(u, location.href);
      return x.origin + x.pathname;
    } catch {
      return "";
    }
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };

  const TEST_ATTRS = ["data-testid", "data-test", "data-cy", "data-qa", "data-test-id"];

  // Ruta CSS corta y legible: hasta 4 ancestros, preferimos id / data-testid / role.
  const path = (el) => {
    const parts = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 4 && n !== document.body; n = n.parentElement, i++) {
      const tid = TEST_ATTRS.map((a) => n.getAttribute(a)).find(Boolean);
      let part = n.tagName.toLowerCase();
      if (n.id && !/\d{4,}|[:]/.test(n.id)) part += `#${n.id}`;
      else if (tid) part += `[data-testid="${tid}"]`;
      else if (n.getAttribute("role")) part += `[role="${n.getAttribute("role")}"]`;
      parts.unshift(part);
      if (n.id || tid) break;
    }
    return parts.join(" > ");
  };

  const describe = (el) => {
    const out = { tag: el.tagName.toLowerCase(), visible: visible(el), path: path(el) };
    for (const a of ["type", "name", "id", "role", "aria-label", "placeholder", "accept", "inputmode", "autocomplete", "aria-haspopup", "aria-expanded", "aria-checked", "maxlength"]) {
      const v = el.getAttribute(a);
      if (v) out[a] = redact(v);
    }
    for (const a of TEST_ATTRS) if (el.getAttribute(a)) out[a] = el.getAttribute(a);
    if (el.disabled) out.disabled = true;
    if (el.multiple) out.multiple = true;
    if (el.required) out.required = true;
    const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lab) out.label = redact(lab.textContent);
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) out.labelledby = redact(labelled.split(" ").map((i) => document.getElementById(i)?.textContent || "").join(" "));
    if (!/^(input|textarea|select)$/.test(out.tag)) out.text = redact(el.textContent);
    if (out.tag === "select") out.options = [...el.options].slice(0, 12).map((o) => redact(o.textContent));
    if (out.tag === "a") out.href = cleanUrl(el.getAttribute("href"));
    return out;
  };

  const CONTROLS =
    'input, textarea, select, button, [role="button"], [role="menuitem"], [role="option"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [contenteditable="true"]';
  const ACTION_LINK = /eliminar|borrar|editar|vender|publicar|subir|vendid|mis (productos|anuncios)|desactivar|reservar/i;

  const items = [...document.querySelectorAll(CONTROLS)].map(describe);
  for (const a of document.querySelectorAll("a[href]")) {
    if (ACTION_LINK.test(a.textContent || "") || a.closest('[role="dialog"], [role="menu"]')) items.push(describe(a));
  }

  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open], [role="menu"], [aria-modal="true"]')]
    .filter(visible)
    .map((d) => ({ path: path(d), role: d.getAttribute("role"), text: redact((d.innerText || "").slice(0, 200)) }));

  const result = {
    captured_at: new Date().toISOString(),
    url: cleanUrl(location.href),
    title: redact(document.title),
    headings: [...document.querySelectorAll("h1, h2")].filter(visible).slice(0, 8).map((h) => redact(h.textContent)),
    file_inputs: [...document.querySelectorAll('input[type="file"]')].map(describe),
    open_dialogs_or_menus: dialogs,
    controls: items,
    counts: { controls: items.length, visible: items.filter((i) => i.visible).length },
  };

  const json = JSON.stringify(result, null, 1);
  try {
    copy(json); // helper de la consola de Chrome
    console.log(`✔ Copiado al portapapeles (${(json.length / 1024).toFixed(1)} KB). Pégalo en el chat.`);
  } catch {
    console.log(json);
  }
  return result.counts;
})();
