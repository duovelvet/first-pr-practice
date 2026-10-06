import crypto from 'node:crypto';
import { db, now } from './db.js';

const SESSION_MS = 30 * 24 * 3600 * 1000;

export const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${h.toString('hex')}`;
};
export const checkPassword = (pw, stored) => {
  const [s, h] = stored.split(':');
  const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
};

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(sha(token), userId, now() + SESSION_MS);
  return token;
}
export const destroySession = (token) => db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(token));

export function userFromToken(token) {
  if (!token) return null;
  const row = db
    .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?')
    .get(sha(token), now());
  return row && !row.banned ? row : null;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function ageFrom(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const t = new Date();
  let age = t.getUTCFullYear() - d.getUTCFullYear();
  const m = t.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && t.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

/** Los hombres solos necesitan suscripción activa; parejas y mujeres son gratis. */
export function hasPremiumAccess(u) {
  if (u.kind !== 'man') return true;
  return u.sub_status === 'active' && u.sub_until > now();
}

export function isBlockedEitherWay(a, b) {
  return !!db
    .prepare('SELECT 1 FROM blocks WHERE (blocker=? AND blocked=?) OR (blocker=? AND blocked=?)')
    .get(a, b, b, a);
}

export function areMatched(a, b) {
  const r = db
    .prepare('SELECT COUNT(*) c FROM likes WHERE value=1 AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))')
    .get(a, b, b, a);
  return r.c === 2;
}

/** Vista pública: nunca expone email, fechas de nacimiento ni datos de pago. */
export function publicUser(u) {
  return {
    id: u.id,
    kind: u.kind,
    display_name: u.display_name,
    bio: u.bio,
    city: u.city,
    looking_for: u.looking_for,
    ages: [ageFrom(u.birth1), u.birth2 ? ageFrom(u.birth2) : null].filter((x) => x != null),
  };
}

export function selfUser(u) {
  return {
    ...publicUser(u),
    email: u.email,
    birth1: u.birth1,
    birth2: u.birth2,
    is_admin: !!u.is_admin,
    premium: hasPremiumAccess(u),
    sub_status: u.sub_status,
    sub_until: u.sub_until,
  };
}

/** Limitador simple en memoria (por clave). */
export function rateLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    arr.push(t);
    hits.set(key, arr);
    return arr.length <= max;
  };
}
