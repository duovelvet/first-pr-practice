/** Crea elementos DOM sin innerHTML (evita XSS con contenido de usuarios). */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  return add(el, kids);
}

/** Como Node.append, pero admite arrays anidados y omite null/false. */
export function add(el, ...kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export async function api(method, url, body, opts = {}) {
  const isRaw = body instanceof Blob;
  const r = await fetch('/api' + url, {
    method,
    headers: isRaw ? { 'Content-Type': body.type } : body ? { 'Content-Type': 'application/json' } : {},
    body: isRaw ? body : body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || `Error ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

let toastT;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.style.display = 'none'), 3500);
}

export const KIND = { couple: 'Pareja', woman: 'Mujer', man: 'Hombre' };
export const photoUrl = (id) => `/api/photos/${id}/file`;
export const fmtDate = (ms) =>
  new Date(ms).toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const fmtTime = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
export const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
export const ageText = (u) => (u.ages?.length ? u.ages.join(' / ') + ' años' : '');
