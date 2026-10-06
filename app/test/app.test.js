import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'velvet-'));
Object.assign(process.env, {
  DATA_DIR: tmp, SPEED_ROUND_SECONDS: '1', SPEED_DECIDE_SECONDS: '5', MIRROR_SECONDS: '1', ADMIN_EMAIL: 'admin@x.com', AUTH_RATE_MAX: '1000',
});

let server, base;
before(async () => {
  const { createApp } = await import('../server/index.js');
  server = createApp();
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function signup(email, kind, extra = {}) {
  const r = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, password: 'password123', kind, display_name: email.split('@')[0], birth1: '1990-01-01',
      birth2: kind === 'couple' ? '1991-02-02' : undefined, accept_terms: true, city: 'Madrid', ...extra,
    }),
  });
  const cookie = r.headers.get('set-cookie')?.split(';')[0];
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + '/api' + url, {
      method,
      headers: { cookie, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const me = (await call('GET', '/me')).body;
  return { r, cookie, call, me };
}

function wsOf(cookie) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie } });
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    inbox.push(m);
    waiters.splice(0).forEach((w) => w());
  });
  ws.next = async (pred, ms = 6000) => {
    const t0 = Date.now();
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      if (Date.now() - t0 > ms) throw new Error('timeout esperando mensaje ws');
      await new Promise((r) => { waiters.push(r); setTimeout(r, 100); });
    }
  };
  ws.sendJson = (o) => ws.send(JSON.stringify(o));
  return new Promise((r) => ws.on('open', () => r(ws)));
}

test('registro: menores y datos inválidos se rechazan', async () => {
  const bad = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'kid@x.com', password: 'password123', kind: 'woman', display_name: 'k', birth1: '2015-01-01', accept_terms: true }),
  });
  assert.equal(bad.status, 400);
  const noTerms = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'k2@x.com', password: 'password123', kind: 'woman', display_name: 'k', birth1: '1990-01-01' }),
  });
  assert.equal(noTerms.status, 400);
  const coupleOneMinor = await signup('c0@x.com', 'couple', { birth2: '2012-01-01' });
  assert.equal(coupleOneMinor.r.status, 400);
});

test('hombres solos: mensajes y speed dating requieren suscripción; mujeres y parejas gratis', async () => {
  const man = await signup('man1@x.com', 'man');
  const woman = await signup('woman1@x.com', 'woman');
  assert.equal(man.me.premium, false);
  assert.equal(woman.me.premium, true);
  assert.equal((await man.call('POST', `/messages/${woman.me.id}`, { body: 'hola' })).status, 402);
  assert.equal((await woman.call('POST', `/messages/${man.me.id}`, { body: 'hola' })).status, 201);
  const ws = await wsOf(man.cookie);
  ws.sendJson({ t: 'queue:join' });
  assert.equal((await ws.next((m) => m.t === 'error')).code, 'premium_required');
  ws.close();
  await man.call('POST', '/billing/dev-activate');
  assert.equal((await man.call('GET', '/me')).body.premium, true);
  assert.equal((await man.call('POST', `/messages/${woman.me.id}`, { body: 'gracias' })).status, 201);
  const thread = (await woman.call('GET', `/messages/${man.me.id}`)).body;
  assert.deepEqual(thread.map((m) => m.body), ['hola', 'gracias']);
});

test('fotos: validación de formato y privacidad hasta el match', async () => {
  const a = await signup('pa@x.com', 'woman');
  const b = await signup('pb@x.com', 'couple');
  const bad = await a.call('POST', '/photos', Buffer.from('<script>alert(1)</script>'), { 'Content-Type': 'image/png' });
  assert.equal(bad.status, 400);
  const pub = await a.call('POST', '/photos', PNG, { 'Content-Type': 'image/png' });
  const priv = await a.call('POST', '/photos?private=1', PNG, { 'Content-Type': 'image/png' });
  assert.equal(pub.status, 201);
  const prof = (await b.call('GET', `/users/${a.me.id}`)).body;
  assert.equal(prof.photos.length, 1);
  assert.equal((await b.call('GET', `/photos/${priv.body.id}/file`)).status, 403);
  assert.equal((await b.call('GET', `/photos/${pub.body.id}/file`)).status !== 403, true);
  // like mutuo → match → ve fotos privadas
  await b.call('POST', `/like/${a.me.id}`, {});
  assert.equal((await a.call('POST', `/like/${b.me.id}`, {})).body.match, true);
  assert.equal((await b.call('GET', `/users/${a.me.id}`)).body.photos.length, 2);
});

test('eventos: la dirección solo se ve al apuntarse; bloqueo oculta usuarios', async () => {
  const org = await signup('org@x.com', 'couple');
  const guest = await signup('guest@x.com', 'woman');
  const ev = await org.call('POST', '/events', { title: 'Fiesta', address: 'Calle Secreta 1', starts_at: Date.now() + 86400000, kind: 'party' });
  assert.equal(ev.status, 201);
  let list = (await guest.call('GET', '/events')).body;
  assert.equal(list.find((e) => e.id === ev.body.id).address, null);
  await guest.call('POST', `/events/${ev.body.id}/rsvp`);
  list = (await guest.call('GET', '/events')).body;
  assert.equal(list.find((e) => e.id === ev.body.id).address, 'Calle Secreta 1');
  assert.equal((await guest.call('POST', '/events', { title: 'x', starts_at: 1 })).status, 400);
  await guest.call('POST', `/block/${org.me.id}`);
  assert.equal((await guest.call('GET', `/users/${org.me.id}`)).status, 404);
  assert.equal((await guest.call('DELETE', `/events/${ev.body.id}`)).status, 403);
});

test('speed dating pareja↔solo → seguir mutuo → oca y espejo', async () => {
  const couple = await signup('cp@x.com', 'couple');
  const single = await signup('sg@x.com', 'woman');
  const wc = await wsOf(couple.cookie);
  const wsg = await wsOf(single.cookie);
  wc.sendJson({ t: 'queue:join', mixed: true });
  wsg.sendJson({ t: 'queue:join', mixed: true });
  const s1 = await wc.next((m) => m.t === 'room:start');
  const s2 = await wsg.next((m) => m.t === 'room:start');
  assert.equal(s1.peer.id, single.me.id);
  assert.equal(s2.peer.id, couple.me.id);
  assert.notEqual(s1.initiator, s2.initiator);

  // señalización WebRTC retransmitida
  wc.sendJson({ t: 'rtc', data: { hello: 1 } });
  assert.deepEqual((await wsg.next((m) => m.t === 'rtc')).data, { hello: 1 });

  await wc.next((m) => m.t === 'room:phase' && m.phase === 'decide');
  wc.sendJson({ t: 'round:decision', choice: 'continue' });
  wsg.sendJson({ t: 'round:decision', choice: 'continue' });
  const open = await wc.next((m) => m.t === 'room:phase' && m.phase === 'open');
  assert.equal(open.matched, true);
  assert.equal((await couple.call('GET', '/matches')).body.length, 1);

  // Oca
  wc.sendJson({ t: 'game:propose', game: 'oca' });
  await wsg.next((m) => m.t === 'game:state' && m.game.status === 'proposed');
  wc.sendJson({ t: 'game:accept' }); // el proponente no puede aceptar su propia propuesta
  wsg.sendJson({ t: 'game:accept' });
  let g = (await wc.next((m) => m.t === 'game:state' && m.game.status === 'playing')).game;
  const first = g.turn;
  const roller = first === couple.me.id ? wc : wsg;
  const waiter = first === couple.me.id ? wsg : wc;
  waiter.sendJson({ t: 'oca:roll' }); // fuera de turno: ignorado
  roller.sendJson({ t: 'oca:roll' });
  g = (await wc.next((m) => m.t === 'game:state' && m.game.last)).game;
  assert.equal(g.last.by, first);
  assert.ok(g.last.roll >= 1 && g.last.roll <= 6);

  // Espejo
  wc.sendJson({ t: 'game:stop' });
  wc.sendJson({ t: 'game:propose', game: 'mirror' });
  wsg.sendJson({ t: 'game:accept' });
  g = (await wc.next((m) => m.t === 'game:state' && m.game?.type === 'mirror' && m.game.status === 'show')).game;
  assert.ok(g.endsAt > Date.now());
  const rep = (await wc.next((m) => m.t === 'game:state' && m.game?.status === 'repeat')).game;
  assert.equal(rep.performer, g.performer);
  wc.sendJson({ t: 'game:stop' });
  await wsg.next((m) => m.t === 'game:state' && m.game === null);

  wc.sendJson({ t: 'room:leave' });
  await wsg.next((m) => m.t === 'room:end');
  wc.close();
  wsg.close();
});

test('si uno pasa no hay match y la sala se cierra', async () => {
  const couple = await signup('cp2@x.com', 'couple');
  const single = await signup('sg2@x.com', 'woman');
  const wc = await wsOf(couple.cookie);
  const wsg = await wsOf(single.cookie);
  wc.sendJson({ t: 'queue:join', mixed: true });
  wsg.sendJson({ t: 'queue:join', mixed: true });
  await wc.next((m) => m.t === 'room:start');
  await wc.next((m) => m.t === 'room:phase' && m.phase === 'decide');
  wc.sendJson({ t: 'round:decision', choice: 'continue' });
  wsg.sendJson({ t: 'round:decision', choice: 'pass' });
  assert.equal((await wc.next((m) => m.t === 'room:end')).reason, 'no_match');
  assert.equal((await couple.call('GET', '/matches')).body.length, 0);
  wc.close();
  wsg.close();
});

test('admin: moderación y baneo', async () => {
  const admin = await signup('admin@x.com', 'woman');
  const troll = await signup('troll@x.com', 'man');
  const victim = await signup('victim@x.com', 'woman');
  assert.equal(admin.me.is_admin, true);
  assert.equal((await victim.call('GET', '/admin/reports')).status, 403);
  await victim.call('POST', `/report/${troll.me.id}`, { reason: 'acoso' });
  const reps = (await admin.call('GET', '/admin/reports')).body;
  assert.equal(reps.length, 1);
  await admin.call('POST', `/admin/ban/${troll.me.id}`);
  assert.equal((await troll.call('GET', '/me')).status, 401);
});

test('emparejamiento por defecto: pareja↔pareja y mujer↔hombre; los cruces solo si ambos lo piden', async () => {
  const { compatible } = await import('../server/realtime.js');
  const q = (kind, mixed = false) => ({ kind, mixed });
  assert.equal(compatible(q('couple'), q('couple')), true);
  assert.equal(compatible(q('woman'), q('man')), true);
  assert.equal(compatible(q('woman'), q('woman')), false);
  assert.equal(compatible(q('man'), q('man')), false);
  assert.equal(compatible(q('couple'), q('woman')), false);
  assert.equal(compatible(q('couple', true), q('man')), false);
  assert.equal(compatible(q('couple', true), q('man', true)), true);

  const c1 = await signup('pp1@x.com', 'couple');
  const c2 = await signup('pp2@x.com', 'couple');
  const w = await signup('mw@x.com', 'woman');
  const m = await signup('mm@x.com', 'man');
  await m.call('POST', '/billing/dev-activate');
  const [w1, w2, ww, wm] = await Promise.all([c1, c2, w, m].map((u) => wsOf(u.cookie)));
  // solo la mujer en cola: no se empareja con una pareja
  ww.sendJson({ t: 'queue:join' });
  w1.sendJson({ t: 'queue:join' });
  await ww.next((x) => x.t === 'queue:joined');
  await w1.next((x) => x.t === 'queue:joined');
  await new Promise((r) => setTimeout(r, 300));
  w2.sendJson({ t: 'queue:join' });
  const a = await w1.next((x) => x.t === 'room:start');
  assert.equal(a.peer.id, c2.me.id);
  wm.sendJson({ t: 'queue:join' });
  const b = await ww.next((x) => x.t === 'room:start');
  assert.equal(b.peer.id, m.me.id);
  [w1, w2, ww, wm].forEach((s) => s.close());
});
