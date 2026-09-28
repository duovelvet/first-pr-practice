import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, now, UPLOAD_DIR } from './db.js';
import {
  hashPassword, checkPassword, createSession, destroySession, userFromToken, parseCookies,
  ageFrom, hasPremiumAccess, isBlockedEitherWay, areMatched, publicUser, selfUser, rateLimiter,
} from './lib.js';
import { isOnline, onlineIds, inSpeedDating, pushTo } from './realtime.js';
import { billingRoutes, PRICE_LABEL, DEV_BILLING } from './billing.js';

const authLimit = rateLimiter(Number(process.env.AUTH_RATE_MAX || 10), 15 * 60 * 1000);
const msgLimit = rateLimiter(30, 60 * 1000);
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase();

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

export function requireAuth(req, res, next) {
  const u = userFromToken(parseCookies(req.headers.cookie).sid);
  if (!u) return bad(res, 'No autenticado', 401);
  req.user = u;
  next();
}
const requirePremium = (req, res, next) =>
  hasPremiumAccess(req.user) ? next() : bad(res, 'Necesitas la suscripción premium', 402);
const requireAdmin = (req, res, next) => (req.user.is_admin ? next() : bad(res, 'Prohibido', 403));

function setCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`);
}

const IMG_TYPES = [
  ['image/jpeg', 'jpg', (b) => b[0] === 0xff && b[1] === 0xd8],
  ['image/png', 'png', (b) => b.subarray(1, 4).toString() === 'PNG'],
  ['image/webp', 'webp', (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'],
];

export function buildApi() {
  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));

  /* ---------- Config ---------- */
  api.get('/config', (_req, res) => {
    const ice = [{ urls: 'stun:stun.l.google.com:19302' }];
    if (process.env.TURN_URL) {
      ice.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER, credential: process.env.TURN_PASS });
    }
    res.json({
      iceServers: ice,
      price: PRICE_LABEL,
      devBilling: DEV_BILLING,
      roundSeconds: Number(process.env.SPEED_ROUND_SECONDS || 180),
      board: JSON.parse(fs.readFileSync(new URL('./board.json', import.meta.url), 'utf8')),
    });
  });

  /* ---------- Auth ---------- */
  api.post('/auth/register', (req, res) => {
    if (!authLimit(req.ip)) return bad(res, 'Demasiados intentos, espera unos minutos', 429);
    const b = req.body || {};
    const email = str(b.email, 200).toLowerCase();
    const kind = b.kind;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'Email no válido');
    if (typeof b.password !== 'string' || b.password.length < 8) return bad(res, 'La contraseña debe tener al menos 8 caracteres');
    if (!['couple', 'woman', 'man'].includes(kind)) return bad(res, 'Tipo de cuenta no válido');
    if (b.accept_terms !== true) return bad(res, 'Debes aceptar los términos y confirmar que eres mayor de edad');
    const name = str(b.display_name, 40);
    if (!name) return bad(res, 'Falta el nombre público');
    const a1 = ageFrom(b.birth1);
    if (a1 == null || a1 < 18 || a1 > 110) return bad(res, 'Debes ser mayor de 18 años');
    let birth2 = null;
    if (kind === 'couple') {
      const a2 = ageFrom(b.birth2);
      if (a2 == null || a2 < 18 || a2 > 110) return bad(res, 'Ambos miembros de la pareja deben ser mayores de 18 años');
      birth2 = b.birth2;
    }
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return bad(res, 'Ese email ya está registrado', 409);
    const isAdmin = ADMIN_EMAIL && email === ADMIN_EMAIL ? 1 : 0;
    const r = db
      .prepare(
        'INSERT INTO users (email,pass_hash,kind,display_name,city,birth1,birth2,is_admin,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(email, hashPassword(b.password), kind, name, str(b.city, 60), b.birth1, birth2, isAdmin, now());
    setCookie(res, createSession(Number(r.lastInsertRowid)));
    res.status(201).json({ ok: true });
  });

  api.post('/auth/login', (req, res) => {
    if (!authLimit(req.ip)) return bad(res, 'Demasiados intentos, espera unos minutos', 429);
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(str(req.body?.email, 200).toLowerCase());
    if (!u || typeof req.body?.password !== 'string' || !checkPassword(req.body.password, u.pass_hash)) {
      return bad(res, 'Credenciales incorrectas', 401);
    }
    if (u.banned) return bad(res, 'Cuenta suspendida', 403);
    setCookie(res, createSession(u.id));
    res.json({ ok: true });
  });

  api.post('/auth/logout', (req, res) => {
    const t = parseCookies(req.headers.cookie).sid;
    if (t) destroySession(t);
    res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/');
    res.json({ ok: true });
  });

  api.get('/me', requireAuth, (req, res) => res.json(selfUser(req.user)));
  api.put('/me', requireAuth, (req, res) => {
    const b = req.body || {};
    db.prepare('UPDATE users SET display_name=?, bio=?, city=?, looking_for=? WHERE id=?').run(
      str(b.display_name, 40) || req.user.display_name,
      str(b.bio, 1000),
      str(b.city, 60),
      str(b.looking_for, 200),
      req.user.id,
    );
    res.json({ ok: true });
  });

  /* ---------- Perfiles y descubrimiento ---------- */
  const photosFor = (ownerId, viewerId) => {
    const full = ownerId === viewerId || areMatched(ownerId, viewerId);
    return db
      .prepare(`SELECT id, private FROM photos WHERE user_id=? ${full ? '' : 'AND private=0'} ORDER BY id`)
      .all(ownerId)
      .map((p) => ({ id: p.id, private: !!p.private }));
  };

  api.get('/users/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id=? AND banned=0').get(id);
    if (!u || isBlockedEitherWay(id, req.user.id)) return bad(res, 'No encontrado', 404);
    res.json({
      ...publicUser(u),
      online: isOnline(id),
      matched: areMatched(id, req.user.id),
      photos: photosFor(id, req.user.id),
    });
  });

  api.get('/discover', requireAuth, (req, res) => {
    const me = req.user;
    const rows = db
      .prepare(
        `SELECT * FROM users u WHERE u.id != ? AND u.banned=0
         AND NOT EXISTS (SELECT 1 FROM likes l WHERE l.from_id=? AND l.to_id=u.id)
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker=? AND b.blocked=u.id) OR (b.blocker=u.id AND b.blocked=?))
         AND EXISTS (SELECT 1 FROM photos p WHERE p.user_id=u.id AND p.private=0)
         ORDER BY (u.city = ? AND u.city != '') DESC, RANDOM() LIMIT 20`,
      )
      .all(me.id, me.id, me.id, me.id, me.city);
    res.json(rows.map((u) => ({ ...publicUser(u), online: isOnline(u.id), photos: photosFor(u.id, me.id) })));
  });

  api.post('/like/:id', requireAuth, (req, res) => {
    const to = Number(req.params.id);
    const value = req.body?.value === 0 ? 0 : 1;
    if (to === req.user.id || !db.prepare('SELECT 1 FROM users WHERE id=? AND banned=0').get(to) || isBlockedEitherWay(to, req.user.id)) {
      return bad(res, 'No encontrado', 404);
    }
    db.prepare('INSERT INTO likes VALUES (?,?,?,?) ON CONFLICT(from_id,to_id) DO UPDATE SET value=excluded.value').run(req.user.id, to, value, now());
    const match = value === 1 && areMatched(req.user.id, to);
    if (match) {
      pushTo(to, { t: 'match', user: publicUser(req.user) });
    }
    res.json({ match });
  });

  api.get('/matches', requireAuth, (req, res) => {
    const rows = db
      .prepare(
        `SELECT u.* FROM users u
         JOIN likes a ON a.from_id=? AND a.to_id=u.id AND a.value=1
         JOIN likes b ON b.from_id=u.id AND b.to_id=? AND b.value=1
         WHERE u.banned=0
         AND NOT EXISTS (SELECT 1 FROM blocks k WHERE (k.blocker=? AND k.blocked=u.id) OR (k.blocker=u.id AND k.blocked=?))`,
      )
      .all(req.user.id, req.user.id, req.user.id, req.user.id);
    res.json(rows.map((u) => ({ ...publicUser(u), online: isOnline(u.id), photos: photosFor(u.id, req.user.id).slice(0, 1) })));
  });

  /* ---------- Fotos ---------- */
  api.post('/photos', requireAuth, express.raw({ type: 'image/*', limit: '6mb' }), (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 16) return bad(res, 'Imagen no válida');
    const type = IMG_TYPES.find(([mime, , check]) => req.headers['content-type'].startsWith(mime) && check(buf));
    if (!type) return bad(res, 'Solo JPG, PNG o WebP');
    const count = db.prepare('SELECT COUNT(*) c FROM photos WHERE user_id=?').get(req.user.id).c;
    if (count >= 12) return bad(res, 'Máximo 12 fotos');
    const file = `${crypto.randomUUID()}.${type[1]}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
    const priv = req.query.private === '1' ? 1 : 0;
    const r = db.prepare('INSERT INTO photos (user_id,file,private,created_at) VALUES (?,?,?,?)').run(req.user.id, file, priv, now());
    res.status(201).json({ id: Number(r.lastInsertRowid), private: !!priv });
  });

  api.get('/photos/:id/file', requireAuth, (req, res) => {
    const p = db.prepare('SELECT * FROM photos WHERE id=?').get(Number(req.params.id));
    if (!p) return bad(res, 'No encontrada', 404);
    const owner = p.user_id === req.user.id;
    if (!owner) {
      if (isBlockedEitherWay(p.user_id, req.user.id)) return bad(res, 'No encontrada', 404);
      if (p.private && !areMatched(p.user_id, req.user.id)) return bad(res, 'Foto privada', 403);
    }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(path.join(path.resolve(UPLOAD_DIR), p.file));
  });

  api.put('/photos/:id', requireAuth, (req, res) => {
    db.prepare('UPDATE photos SET private=? WHERE id=? AND user_id=?').run(req.body?.private ? 1 : 0, Number(req.params.id), req.user.id);
    res.json({ ok: true });
  });

  api.delete('/photos/:id', requireAuth, (req, res) => {
    const p = db.prepare('SELECT * FROM photos WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
    if (!p) return bad(res, 'No encontrada', 404);
    db.prepare('DELETE FROM photos WHERE id=?').run(p.id);
    fs.rmSync(path.join(UPLOAD_DIR, p.file), { force: true });
    res.json({ ok: true });
  });

  /* ---------- Mensajes ---------- */
  api.get('/conversations', requireAuth, (req, res) => {
    const me = req.user.id;
    const rows = db
      .prepare(
        `SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END AS other, MAX(id) AS last_id,
                SUM(CASE WHEN to_id=? AND read_at IS NULL THEN 1 ELSE 0 END) AS unread
         FROM messages WHERE from_id=? OR to_id=? GROUP BY other ORDER BY last_id DESC`,
      )
      .all(me, me, me, me);
    const out = [];
    for (const r of rows) {
      const u = db.prepare('SELECT * FROM users WHERE id=? AND banned=0').get(r.other);
      if (!u || isBlockedEitherWay(me, u.id)) continue;
      const last = db.prepare('SELECT body, created_at FROM messages WHERE id=?').get(r.last_id);
      out.push({ user: { ...publicUser(u), online: isOnline(u.id) }, last, unread: r.unread });
    }
    res.json(out);
  });

  api.get('/messages/:id', requireAuth, (req, res) => {
    const other = Number(req.params.id);
    if (isBlockedEitherWay(req.user.id, other)) return bad(res, 'No encontrado', 404);
    db.prepare('UPDATE messages SET read_at=? WHERE from_id=? AND to_id=? AND read_at IS NULL').run(now(), other, req.user.id);
    const rows = db
      .prepare(
        `SELECT id, from_id, body, created_at FROM messages
         WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY id DESC LIMIT 200`,
      )
      .all(req.user.id, other, other, req.user.id);
    res.json(rows.reverse());
  });

  api.post('/messages/:id', requireAuth, requirePremium, (req, res) => {
    const to = Number(req.params.id);
    const body = str(req.body?.body, 2000);
    if (!body) return bad(res, 'Mensaje vacío');
    if (!msgLimit(req.user.id)) return bad(res, 'Vas demasiado rápido', 429);
    const target = db.prepare('SELECT 1 FROM users WHERE id=? AND banned=0').get(to);
    if (!target || to === req.user.id || isBlockedEitherWay(req.user.id, to)) return bad(res, 'No encontrado', 404);
    const r = db.prepare('INSERT INTO messages (from_id,to_id,body,created_at) VALUES (?,?,?,?)').run(req.user.id, to, body, now());
    const msg = { id: Number(r.lastInsertRowid), from_id: req.user.id, body, created_at: now() };
    pushTo(to, { t: 'message', message: msg, from: publicUser(req.user) });
    res.status(201).json(msg);
  });

  /* ---------- Eventos ---------- */
  const eventView = (e, uid) => {
    const going = db.prepare('SELECT COUNT(*) c FROM event_rsvps WHERE event_id=?').get(e.id).c;
    const mine = !!db.prepare('SELECT 1 FROM event_rsvps WHERE event_id=? AND user_id=?').get(e.id, uid);
    const creator = db.prepare('SELECT * FROM users WHERE id=?').get(e.creator_id);
    return {
      id: e.id, title: e.title, description: e.description, kind: e.kind, city: e.city,
      starts_at: e.starts_at, capacity: e.capacity, official: !!e.official, going, going_me: mine,
      // la dirección exacta solo la ven quienes se apuntan (y el organizador)
      address: mine || e.creator_id === uid ? e.address : null,
      creator: creator ? publicUser(creator) : null,
      mine: e.creator_id === uid,
    };
  };

  api.get('/events', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM events WHERE starts_at > ? ORDER BY starts_at LIMIT 100').all(now() - 3 * 3600 * 1000);
    res.json(rows.filter((e) => !isBlockedEitherWay(e.creator_id, req.user.id)).map((e) => eventView(e, req.user.id)));
  });

  api.post('/events', requireAuth, (req, res) => {
    const b = req.body || {};
    const title = str(b.title, 120);
    const starts = Number(b.starts_at);
    if (!title) return bad(res, 'Falta el título');
    if (!Number.isFinite(starts) || starts < now()) return bad(res, 'La fecha debe ser futura');
    const kind = ['meetup', 'party', 'speed_dating', 'online'].includes(b.kind) ? b.kind : 'meetup';
    const r = db
      .prepare('INSERT INTO events (creator_id,title,description,kind,city,address,starts_at,capacity,official,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(req.user.id, title, str(b.description, 2000), kind, str(b.city, 60), str(b.address, 200), starts,
        Math.max(0, Math.min(5000, Number(b.capacity) || 0)), req.user.is_admin ? 1 : 0, now());
    res.status(201).json(eventView(db.prepare('SELECT * FROM events WHERE id=?').get(Number(r.lastInsertRowid)), req.user.id));
  });

  api.post('/events/:id/rsvp', requireAuth, (req, res) => {
    const e = db.prepare('SELECT * FROM events WHERE id=?').get(Number(req.params.id));
    if (!e) return bad(res, 'No encontrado', 404);
    const going = db.prepare('SELECT COUNT(*) c FROM event_rsvps WHERE event_id=?').get(e.id).c;
    if (e.capacity && going >= e.capacity) return bad(res, 'Evento completo', 409);
    db.prepare('INSERT OR IGNORE INTO event_rsvps VALUES (?,?)').run(e.id, req.user.id);
    res.json(eventView(e, req.user.id));
  });
  api.delete('/events/:id/rsvp', requireAuth, (req, res) => {
    db.prepare('DELETE FROM event_rsvps WHERE event_id=? AND user_id=?').run(Number(req.params.id), req.user.id);
    res.json({ ok: true });
  });
  api.delete('/events/:id', requireAuth, (req, res) => {
    const e = db.prepare('SELECT * FROM events WHERE id=?').get(Number(req.params.id));
    if (!e) return bad(res, 'No encontrado', 404);
    if (e.creator_id !== req.user.id && !req.user.is_admin) return bad(res, 'Prohibido', 403);
    db.prepare('DELETE FROM events WHERE id=?').run(e.id);
    res.json({ ok: true });
  });

  /* ---------- En directo ---------- */
  api.get('/live', requireAuth, (req, res) => {
    const ids = onlineIds().filter((id) => id !== req.user.id);
    const out = [];
    for (const id of ids) {
      const u = db.prepare('SELECT * FROM users WHERE id=? AND banned=0').get(id);
      if (!u || isBlockedEitherWay(id, req.user.id)) continue;
      out.push({ ...publicUser(u), speed_dating: inSpeedDating(id), photos: photosFor(id, req.user.id).slice(0, 1) });
    }
    res.json(out);
  });

  /* ---------- Seguridad ---------- */
  api.post('/block/:id', requireAuth, (req, res) => {
    db.prepare('INSERT OR IGNORE INTO blocks VALUES (?,?)').run(req.user.id, Number(req.params.id));
    res.json({ ok: true });
  });
  api.delete('/block/:id', requireAuth, (req, res) => {
    db.prepare('DELETE FROM blocks WHERE blocker=? AND blocked=?').run(req.user.id, Number(req.params.id));
    res.json({ ok: true });
  });
  api.post('/report/:id', requireAuth, (req, res) => {
    const reason = str(req.body?.reason, 1000);
    if (!reason) return bad(res, 'Indica el motivo');
    db.prepare('INSERT INTO reports (reporter,target,reason,created_at) VALUES (?,?,?,?)').run(req.user.id, Number(req.params.id), reason, now());
    res.status(201).json({ ok: true });
  });

  /* ---------- Admin ---------- */
  api.get('/admin/reports', requireAuth, requireAdmin, (_req, res) => {
    res.json(
      db.prepare(
        `SELECT r.*, t.display_name AS target_name, t.banned AS target_banned, p.display_name AS reporter_name
         FROM reports r JOIN users t ON t.id=r.target JOIN users p ON p.id=r.reporter
         WHERE r.resolved=0 ORDER BY r.id DESC LIMIT 200`,
      ).all(),
    );
  });
  api.post('/admin/ban/:id', requireAuth, requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    db.prepare('UPDATE users SET banned=1 WHERE id=? AND is_admin=0').run(id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    db.prepare('UPDATE reports SET resolved=1 WHERE target=?').run(id);
    res.json({ ok: true });
  });
  api.post('/admin/reports/:id/resolve', requireAuth, requireAdmin, (req, res) => {
    db.prepare('UPDATE reports SET resolved=1 WHERE id=?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  billingRoutes(api, requireAuth);

  api.use((_req, res) => bad(res, 'No encontrado', 404));
  api.use((err, _req, res, _next) => {
    console.error(err);
    bad(res, 'Error interno', 500);
  });
  return api;
}
