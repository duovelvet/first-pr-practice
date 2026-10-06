import { h, add, api, toast, KIND, photoUrl, fmtDate, fmtTime, ageText } from './util.js';
import { createSpeed } from './speed.js';

const view = document.getElementById('view');
const top = document.getElementById('top');
let me = null, config = null, ws = null, speed = null, unread = 0;
let convoOpen = null; // id del usuario cuya conversación está abierta
const listeners = new Set();

/* ---------- WebSocket ---------- */
function connectWs() {
  if (ws && ws.readyState <= 1) return;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'message') {
      if (convoOpen !== m.message.from_id) { unread++; renderTop(); toast(`Nuevo mensaje de ${m.from.display_name}`); }
    } else if (m.t === 'match') toast(`💜 ¡Match con ${m.user.display_name}!`);
    speed.onMessage(m);
    listeners.forEach((f) => f(m));
  };
  ws.onclose = () => me && setTimeout(connectWs, 2000);
}
const send = (o) => ws?.readyState === 1 && ws.send(JSON.stringify(o));

/* ---------- Layout ---------- */
const NAV = [['discover', 'Descubrir'], ['live', 'En directo'], ['speed', 'Speed dating'], ['events', 'Eventos'], ['messages', 'Mensajes'], ['profile', 'Mi perfil']];
function renderTop() {
  const cur = location.hash.split('/')[1]?.split('?')[0] || 'discover';
  top.replaceChildren();
  add(top,
    h('span', { class: 'logo' }, 'Velvet'),
    me && h('nav', {},
      NAV.map(([k, label]) => h('a', { href: `#/${k}`, class: cur === k ? 'on' : '' }, label,
        k === 'messages' && unread > 0 && h('span', { class: 'badge' }, unread))),
      me.kind === 'man' && !me.premium && h('a', { href: '#/premium' }, '⭐ Premium'),
      me.is_admin && h('a', { href: '#/admin' }, 'Admin')),
    me && h('a', { href: '#', onclick: logout }, 'Salir'));
}
async function logout(e) {
  e.preventDefault();
  await api('POST', '/auth/logout');
  ws?.close();
  me = null;
  ws = null;
  speed = null;
  location.hash = '#/login';
  route();
}

/* ---------- Router ---------- */
const routes = { discover, live, speed: speedPage, events, messages, profile, premium, admin, u: userPage, login: authPage };

async function route() {
  speed?.unmount();
  listeners.clear();
  convoOpen = null;
  const [, name = 'discover', arg] = location.hash.replace(/\?.*/, '').split('/');
  if (!me) {
    try {
      const loaded = await api('GET', '/me');
      if (!me) {
        me = loaded;
        config ||= await api('GET', '/config');
        speed ||= createSpeed({ getMe: () => me, send, config });
        connectWs();
      }
    } catch {
      renderTop();
      return authPage();
    }
  }
  if (name === 'login') return (location.hash = '#/discover');
  renderTop();
  try {
    view.replaceChildren();
    await (routes[name] || discover)(arg);
  } catch (e) {
    view.replaceChildren(h('p', { class: 'err' }, e.message));
  }
}
window.addEventListener('hashchange', route);
route();

const set = (...kids) => {
  view.replaceChildren();
  add(view, kids);
};
const errBox = () => h('p', { class: 'err' });

/* ---------- Auth ---------- */
function authPage() {
  let mode = 'login';
  const draw = () => {
    const err = errBox();
    const f = h('form', { class: 'card', style: { maxWidth: '480px', margin: '2rem auto' } });
    const inp = (name, label, type = 'text', extra = {}) => [h('label', {}, label), h('input', { name, type, ...extra })];
    add(f,
      h('h2', {}, mode === 'login' ? 'Entrar' : 'Crear cuenta'),
      inp('email', 'Email', 'email', { required: true }),
      inp('password', 'Contraseña (mín. 8)', 'password', { required: true, minLength: 8 }));
    if (mode === 'register') {
      add(f,
        h('label', {}, 'Tipo de cuenta'),
        h('select', { name: 'kind' },
          h('option', { value: 'couple' }, 'Pareja (gratis)'),
          h('option', { value: 'woman' }, 'Mujer (gratis)'),
          h('option', { value: 'man' }, `Hombre soltero (${'9,99 €/mes'})`)),
        inp('display_name', 'Nombre público', 'text', { required: true, maxLength: 40 }),
        inp('city', 'Ciudad'),
        inp('birth1', 'Fecha de nacimiento (tuya / primera persona)', 'date', { required: true }),
        inp('birth2', 'Fecha de nacimiento de la segunda persona (solo parejas)', 'date'),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'accept_terms' }),
          'Confirmo que todos los miembros de la cuenta somos mayores de 18 años y acepto las normas: respeto, consentimiento y nada de contenido ilegal.'));
    }
    add(f, err, h('button', {}, mode === 'login' ? 'Entrar' : 'Registrarme'),
      h('p', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); mode = mode === 'login' ? 'register' : 'login'; draw(); } },
        mode === 'login' ? '¿No tienes cuenta? Regístrate' : 'Ya tengo cuenta')));
    f.onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      d.accept_terms = f.elements.accept_terms?.checked;
      if (d.kind !== 'couple') delete d.birth2;
      try {
        await api('POST', `/auth/${mode}`, d);
        const same = location.hash === '#/profile';
        location.hash = '#/profile';
        if (same) route();
      } catch (ex) { err.textContent = ex.message; }
    };
    set(f);
    const kind = f.elements.kind;
    if (kind) kind.onchange = () => (f.elements.birth2.required = kind.value === 'couple');
    if (kind) f.elements.birth2.required = true;
  };
  draw();
}

/* ---------- Tarjetas de usuario ---------- */
const firstPhoto = (u) => u.photos?.[0] && { backgroundImage: `url(${photoUrl(u.photos[0].id)})` };
const userCard = (u, extra) =>
  h('a', { class: 'card', href: `#/u/${u.id}`, style: { display: 'block', color: 'inherit', padding: '.6rem' } },
    h('div', { class: 'ph', style: firstPhoto(u) || {} }),
    h('div', {}, u.online && h('span', { class: 'dot' }), h('b', {}, u.display_name), ' ', h('span', { class: 'mute' }, ageText(u))),
    h('div', {}, h('span', { class: 'tag' }, KIND[u.kind]), u.city && h('span', { class: 'mute' }, u.city)), extra);

/* ---------- Descubrir (swipe) ---------- */
async function discover() {
  const deck = await api('GET', '/discover');
  const draw = () => {
    const u = deck[0];
    if (!u) return set(h('div', { class: 'card' }, h('h2', {}, 'No hay más perfiles por ahora'), h('p', { class: 'mute' }, 'Vuelve más tarde o pásate por En directo.')));
    let idx = 0;
    const ph = h('div', { class: 'ph', style: firstPhoto(u) || {}, onclick: () => { idx = (idx + 1) % u.photos.length; ph.style.backgroundImage = `url(${photoUrl(u.photos[idx].id)})`; } });
    const act = async (value) => {
      try {
        const r = await api('POST', `/like/${u.id}`, { value });
        if (r.match) toast(`💜 ¡Match con ${u.display_name}!`);
      } catch (e) { toast(e.message); }
      deck.shift();
      draw();
    };
    set(h('div', { class: 'swipe card' }, ph,
      h('h2', {}, u.online && h('span', { class: 'dot' }), u.display_name, ' ', h('small', { class: 'mute' }, ageText(u))),
      h('div', {}, h('span', { class: 'tag' }, KIND[u.kind]), u.city),
      h('p', {}, u.bio),
      h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: () => act(0) }, '✕'), h('button', { onclick: () => act(1) }, '♥')),
      h('a', { href: `#/u/${u.id}` }, 'Ver perfil completo')));
  };
  draw();
}

/* ---------- En directo ---------- */
async function live() {
  const box = h('div', { class: 'grid' });
  const load = async () => {
    const list = await api('GET', '/live');
    box.replaceChildren(...(list.length
      ? list.map((u) => userCard({ ...u, online: true }, u.speed_dating && h('span', { class: 'tag' }, '🎥 en speed dating')))
      : [h('p', { class: 'mute' }, 'Nadie más conectado ahora mismo.')]));
  };
  await load();
  const t = setInterval(() => (location.hash.startsWith('#/live') ? load().catch(() => {}) : clearInterval(t)), 10000);
  set(h('h1', {}, '🟢 En directo ahora'), box);
}

/* ---------- Speed dating ---------- */
function speedPage() {
  const el = h('div', {});
  set(h('h1', {}, 'Speed dating'), el);
  speed.mount(el);
}

/* ---------- Eventos ---------- */
async function events() {
  const list = h('div', {});
  const load = async () => {
    const evs = await api('GET', '/events');
    list.replaceChildren(...(evs.length ? evs.map(eventCard) : [h('p', { class: 'mute' }, 'No hay eventos próximos. ¡Crea el primero!')]));
  };
  const eventCard = (e) =>
    h('div', { class: 'card' },
      h('div', { class: 'row spread' },
        h('h3', {}, e.title, ' ', e.official && h('span', { class: 'tag' }, '⭐ Oficial'), h('span', { class: 'tag' }, e.kind)),
        h('span', { class: 'mute' }, fmtDate(e.starts_at))),
      h('p', {}, e.description),
      h('p', { class: 'mute' }, `📍 ${e.city || 'Online'}${e.address ? ' · ' + e.address : e.kind !== 'online' ? ' · (dirección visible al apuntarte)' : ''}`),
      h('p', { class: 'mute' }, `${e.going}${e.capacity ? '/' + e.capacity : ''} apuntados · organiza `, h('a', { href: `#/u/${e.creator?.id}` }, e.creator?.display_name || '—')),
      h('div', { class: 'row' },
        e.going_me
          ? h('button', { class: 'ghost', onclick: async () => { await api('DELETE', `/events/${e.id}/rsvp`); load(); } }, 'Cancelar asistencia')
          : h('button', { onclick: async () => { try { await api('POST', `/events/${e.id}/rsvp`); } catch (x) { toast(x.message); } load(); } }, 'Me apunto'),
        (e.mine || me.is_admin) && h('button', { class: 'danger', onclick: async () => { if (confirm('¿Borrar evento?')) { await api('DELETE', `/events/${e.id}`); load(); } } }, 'Borrar')));

  const err = errBox();
  const f = h('form', { class: 'card' },
    h('h3', {}, me.is_admin ? 'Crear evento oficial' : 'Crear un evento'),
    h('label', {}, 'Título'), h('input', { name: 'title', required: true, maxLength: 120 }),
    h('label', {}, 'Tipo'),
    h('select', { name: 'kind' }, [['meetup', 'Quedada'], ['party', 'Fiesta'], ['speed_dating', 'Speed dating'], ['online', 'Online']].map(([v, l]) => h('option', { value: v }, l))),
    h('label', {}, 'Descripción'), h('textarea', { name: 'description', rows: 3 }),
    h('div', { class: 'row' },
      h('div', { style: { flex: 1 } }, h('label', {}, 'Ciudad'), h('input', { name: 'city' })),
      h('div', { style: { flex: 1 } }, h('label', {}, 'Fecha y hora'), h('input', { name: 'starts_at', type: 'datetime-local', required: true })),
      h('div', { style: { width: '110px' } }, h('label', {}, 'Aforo (0=∞)'), h('input', { name: 'capacity', type: 'number', min: 0, value: 0 }))),
    h('label', {}, 'Dirección exacta (solo la verán quienes se apunten)'), h('input', { name: 'address' }),
    err, h('button', {}, 'Publicar'));
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    d.starts_at = new Date(d.starts_at).getTime();
    try { await api('POST', '/events', d); f.reset(); err.textContent = ''; load(); } catch (x) { err.textContent = x.message; }
  };
  set(h('h1', {}, 'Eventos'), f, list);
  await load();
}

/* ---------- Mensajes ---------- */
async function messages(arg) {
  const convos = h('div', { class: 'card' });
  const pane = h('div', { class: 'card' }, h('p', { class: 'mute' }, 'Elige una conversación.'));
  set(h('h1', {}, 'Mensajes'), h('div', { class: 'chat' }, convos, pane));

  const loadConvos = async () => {
    const cs = await api('GET', '/conversations');
    convos.replaceChildren(...(cs.length ? cs.map((c) =>
      h('div', { class: `convo ${convoOpen === c.user.id ? 'on' : ''}`, onclick: () => (location.hash = `#/messages/${c.user.id}`) },
        h('span', {}, c.user.online && h('span', { class: 'dot' }), c.user.display_name), c.unread > 0 && h('span', { class: 'badge' }, c.unread)))
      : [h('p', { class: 'mute' }, 'Aún no tienes conversaciones. Escribe a alguien desde su perfil.')]));
  };

  async function open(id) {
    convoOpen = id;
    const [msgs, u] = await Promise.all([api('GET', `/messages/${id}`), api('GET', `/users/${id}`)]);
    unread = 0; renderTop();
    const box = h('div', { class: 'msgs' });
    const addMsg = (m) => { box.append(h('div', { class: `msg ${m.from_id === me.id ? 'me' : ''}` }, m.body, h('small', { class: 'mute', style: { display: 'block' } }, fmtTime(m.created_at)))); box.scrollTop = box.scrollHeight; };
    msgs.forEach(addMsg);
    const inp = h('input', { placeholder: me.premium ? 'Escribe un mensaje…' : 'Suscríbete para enviar mensajes', maxLength: 2000 });
    const form = h('form', { class: 'row', onsubmit: async (e) => {
      e.preventDefault();
      if (!inp.value.trim()) return;
      try { addMsg(await api('POST', `/messages/${id}`, { body: inp.value })); inp.value = ''; loadConvos(); } catch (x) { toast(x.message); }
    } }, h('div', { style: { flex: 1 } }, inp), h('button', {}, 'Enviar'));
    pane.replaceChildren(h('h3', {}, h('a', { href: `#/u/${id}` }, u.display_name)), box, form);
    listeners.add((m) => { if (m.t === 'message' && m.message.from_id === id) { addMsg(m.message); api('GET', `/messages/${id}`); } if (m.t === 'message') loadConvos(); });
    loadConvos();
  }
  await loadConvos();
  if (arg) await open(Number(arg));
}

/* ---------- Perfil de otra persona ---------- */
async function userPage(id) {
  const u = await api('GET', `/users/${id}`);
  const big = h('div', { class: 'ph', style: { ...(firstPhoto(u) || {}), maxWidth: '380px' } });
  set(h('div', { class: 'card' },
    big,
    h('div', { class: 'thumbs' }, u.photos.map((p) => h('img', { src: photoUrl(p.id), onclick: () => (big.style.backgroundImage = `url(${photoUrl(p.id)})`), alt: '' }))),
    h('h1', {}, u.online && h('span', { class: 'dot' }), u.display_name, ' ', h('small', { class: 'mute' }, ageText(u))),
    h('p', {}, h('span', { class: 'tag' }, KIND[u.kind]), u.city, u.matched && h('span', { class: 'tag' }, '💜 Match')),
    h('p', {}, u.bio),
    u.looking_for && h('p', { class: 'mute' }, 'Busca: ' + u.looking_for),
    !u.matched && h('p', { class: 'mute' }, 'Las fotos privadas se desbloquean al hacer match.'),
    h('div', { class: 'row' },
      h('a', { class: 'btn', href: `#/messages/${u.id}` }, 'Enviar mensaje'),
      h('button', { onclick: async () => { const r = await api('POST', `/like/${u.id}`, { value: 1 }); toast(r.match ? '💜 ¡Match!' : 'Like enviado'); } }, '♥ Me gusta'),
      h('button', { class: 'ghost', onclick: async () => { const reason = prompt('Motivo del reporte'); if (reason) { await api('POST', `/report/${u.id}`, { reason }); toast('Reporte enviado'); } } }, 'Reportar'),
      h('button', { class: 'danger', onclick: async () => { if (confirm('¿Bloquear a esta persona?')) { await api('POST', `/block/${u.id}`); location.hash = '#/discover'; } } }, 'Bloquear'))));
}

/* ---------- Mi perfil + galería ---------- */
async function profile() {
  const full = await api('GET', '/users/' + me.id);
  const err = errBox();
  const f = h('form', { class: 'card' },
    h('h2', {}, `Mi perfil (${KIND[me.kind]})`),
    h('label', {}, 'Nombre público'), h('input', { name: 'display_name', value: me.display_name, maxLength: 40 }),
    h('label', {}, 'Ciudad'), h('input', { name: 'city', value: me.city }),
    h('label', {}, 'Sobre nosotros/mí'), h('textarea', { name: 'bio', rows: 4, maxLength: 1000 }, me.bio),
    h('label', {}, 'Qué buscamos'), h('input', { name: 'looking_for', value: me.looking_for, maxLength: 200 }),
    err, h('button', {}, 'Guardar'));
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('PUT', '/me', Object.fromEntries(new FormData(f))); me = await api('GET', '/me'); toast('Guardado'); renderTop(); } catch (x) { err.textContent = x.message; }
  };
  const gallery = h('div', { class: 'grid' });
  const drawGallery = (photos) => gallery.replaceChildren(...photos.map((p) =>
    h('div', {}, h('div', { class: 'ph', style: { backgroundImage: `url(${photoUrl(p.id)})` } }),
      h('div', { class: 'row' },
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: p.private, onchange: (e) => api('PUT', `/photos/${p.id}`, { private: e.target.checked }) }), 'Privada'),
        h('button', { class: 'danger', onclick: async () => { await api('DELETE', `/photos/${p.id}`); profile(); } }, '🗑')))));
  drawGallery(full.photos);
  const up = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, onchange: async () => {
    for (const file of up.files) {
      try { await api('POST', `/photos?private=${priv.checked ? 1 : 0}`, file); } catch (x) { toast(x.message); }
    }
    profile();
  } });
  const priv = h('input', { type: 'checkbox' });
  set(f, h('div', { class: 'card' }, h('h2', {}, 'Galería'),
    h('p', { class: 'mute' }, 'Las fotos públicas las ve cualquiera. Las privadas solo quienes hacen match contigo. Necesitas al menos una pública para aparecer en Descubrir.'),
    gallery, h('label', { class: 'chk' }, priv, 'Subir como privadas'), up));
}

/* ---------- Premium ---------- */
async function premium() {
  const ok = location.hash.includes('ok=1');
  if (ok) me = await api('GET', '/me');
  set(h('div', { class: 'card' },
    h('h1', {}, '⭐ Premium'),
    me.kind !== 'man'
      ? h('p', {}, 'Las parejas y las mujeres usan Velvet gratis. ¡Disfruta!')
      : me.premium
        ? h('p', {}, `Suscripción activa hasta ${fmtDate(me.sub_until)}.`)
        : h('div', {},
          h('p', {}, `Como hombre soltero, la suscripción cuesta ${config.price} y desbloquea mensajes, speed dating y juegos.`),
          h('button', { onclick: async () => {
            const r = await api('POST', '/billing/checkout');
            if (r.dev) { await api('POST', '/billing/dev-activate'); me = await api('GET', '/me'); toast('Suscripción de PRUEBA activada'); premium(); }
            else location.href = r.url;
          } }, 'Suscribirme'),
          config.devBilling && h('p', { class: 'mute' }, 'Modo desarrollo: Stripe no está configurado, se activa una suscripción de prueba.'))));
}

/* ---------- Admin ---------- */
async function admin() {
  const reps = await api('GET', '/admin/reports');
  set(h('h1', {}, 'Reportes pendientes'), ...(reps.length ? reps.map((r) =>
    h('div', { class: 'card' },
      h('p', {}, h('b', {}, r.reporter_name), ' reporta a ', h('a', { href: `#/u/${r.target}` }, r.target_name), ':'),
      h('p', {}, r.reason),
      h('div', { class: 'row' },
        h('button', { class: 'danger', onclick: async () => { await api('POST', `/admin/ban/${r.target}`); admin(); } }, 'Suspender cuenta'),
        h('button', { class: 'ghost', onclick: async () => { await api('POST', `/admin/reports/${r.id}/resolve`); admin(); } }, 'Descartar')))) : [h('p', { class: 'mute' }, 'Sin reportes.')]));
}
