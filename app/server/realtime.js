import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db, now } from './db.js';
import { userFromToken, parseCookies, publicUser, hasPremiumAccess, isBlockedEitherWay } from './lib.js';

const ROUND_SECONDS = Number(process.env.SPEED_ROUND_SECONDS || 180);
const DECIDE_SECONDS = Number(process.env.SPEED_DECIDE_SECONDS || 20);
const MIRROR_SECONDS = Number(process.env.MIRROR_SECONDS || 90);
const GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS || 10000);
const BOARD = JSON.parse(fs.readFileSync(new URL('./board.json', import.meta.url), 'utf8'));

/** userId -> Set<ws> */
const sockets = new Map();
/** cola de espera: { id, mixed } */
const queue = [];
/** roomId -> room, userId -> room */
const rooms = new Map();
const userRoom = new Map();
/** parejas ya emparejadas en esta sesión de servidor, para no repetir */
const recent = new Set();

const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export const isOnline = (id) => sockets.has(id);
export const onlineIds = () => [...sockets.keys()];
export const inSpeedDating = (id) => userRoom.has(id) || queue.some((q) => q.id === id);

export function pushTo(id, msg) {
  const set = sockets.get(id);
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const ws of set) if (ws.readyState === 1) ws.send(data);
}

const getUser = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);

function leaveQueue(id) {
  const i = queue.findIndex((q) => q.id === id);
  if (i >= 0) queue.splice(i, 1);
}

/**
 * Por defecto: pareja↔pareja y mujer↔hombre.
 * Solo si AMBOS han activado «abrir a cruces» se permite pareja↔solo/a.
 */
export function compatible(a, b) {
  if (a.kind === 'couple' && b.kind === 'couple') return true;
  if (a.kind !== 'couple' && b.kind !== 'couple') return a.kind !== b.kind;
  return a.mixed && b.mixed;
}

function tryMatch() {
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      const a = queue[i], b = queue[j];
      if (!compatible(a, b) || recent.has(pairKey(a.id, b.id)) || isBlockedEitherWay(a.id, b.id)) continue;
      queue.splice(j, 1);
      queue.splice(i, 1);
      createRoom(a.id, b.id);
      return tryMatch();
    }
  }
}

function createRoom(a, b) {
  const room = {
    id: crypto.randomUUID(),
    users: [a, b],
    phase: 'round',
    endsAt: now() + ROUND_SECONDS * 1000,
    choices: {},
    timer: null,
    game: null,
    grace: {},
  };
  rooms.set(room.id, room);
  userRoom.set(a, room);
  userRoom.set(b, room);
  recent.add(pairKey(a, b));
  for (const [me, peer] of [[a, b], [b, a]]) {
    pushTo(me, {
      t: 'room:start',
      roomId: room.id,
      peer: publicUser(getUser(peer)),
      initiator: me === a,
      phase: room.phase,
      endsAt: room.endsAt,
    });
  }
  room.timer = setTimeout(() => toDecide(room), ROUND_SECONDS * 1000);
}

const broadcast = (room, msg) => room.users.forEach((u) => pushTo(u, msg));

function toDecide(room) {
  if (!rooms.has(room.id) || room.phase !== 'round') return;
  room.phase = 'decide';
  room.endsAt = now() + DECIDE_SECONDS * 1000;
  broadcast(room, { t: 'room:phase', phase: 'decide', endsAt: room.endsAt });
  room.timer = setTimeout(() => resolveDecision(room), DECIDE_SECONDS * 1000);
}

function resolveDecision(room) {
  if (!rooms.has(room.id) || room.phase !== 'decide') return;
  clearTimeout(room.timer);
  const [a, b] = room.users;
  if (room.choices[a] === 'continue' && room.choices[b] === 'continue') {
    room.phase = 'open';
    room.endsAt = 0;
    // "seguir" mutuo = match: se registran likes recíprocos
    const ins = db.prepare('INSERT INTO likes VALUES (?,?,1,?) ON CONFLICT(from_id,to_id) DO UPDATE SET value=1');
    ins.run(a, b, now());
    ins.run(b, a, now());
    broadcast(room, { t: 'room:phase', phase: 'open', endsAt: 0, matched: true });
  } else {
    closeRoom(room, 'no_match');
  }
}

function closeRoom(room, reason) {
  clearTimeout(room.timer);
  clearTimeout(room.game?.timer);
  broadcast(room, { t: 'room:end', reason });
  rooms.delete(room.id);
  for (const u of room.users) if (userRoom.get(u) === room) userRoom.delete(u);
}

/* ---------------- Juegos ---------------- */

const other = (room, id) => room.users.find((u) => u !== id);

function gameView(room) {
  const g = room.game;
  if (!g) return null;
  const { timer, ...rest } = g;
  return rest;
}
const sendGame = (room) => broadcast(room, { t: 'game:state', game: gameView(room) });

function startOca(room) {
  const [a, b] = room.users;
  room.game = {
    type: 'oca',
    status: 'playing',
    pos: { [a]: 1, [b]: 1 },
    skip: { [a]: 0, [b]: 0 },
    turn: a,
    last: null,
    winner: null,
    total: BOARD.tiles.length,
  };
}

function ocaRoll(room, uid) {
  const g = room.game;
  if (!g || g.type !== 'oca' || g.status !== 'playing' || g.turn !== uid) return;
  const roll = 1 + crypto.randomInt(6);
  const total = BOARD.tiles.length;
  let pos = g.pos[uid] + roll;
  if (pos > total) pos = total - (pos - total); // rebota al pasarse de la meta
  const notes = [];
  let again = false;
  for (let guard = 0; guard < 10; guard++) {
    const tile = BOARD.tiles[pos - 1];
    notes.push(tile.text);
    if (tile.type === 'goto' && tile.to !== pos) {
      pos = tile.to;
      again = again || !!tile.again;
      continue;
    }
    if (tile.type === 'skip') g.skip[uid] = tile.turns || 1;
    break;
  }
  g.pos[uid] = pos;
  g.last = { by: uid, roll, pos, notes };
  if (pos === total) {
    g.status = 'finished';
    g.winner = uid;
  } else if (!again) {
    let next = other(room, uid);
    if (g.skip[next] > 0) {
      g.skip[next]--;
      next = uid;
      g.last.notes.push('El otro jugador pierde el turno');
    }
    g.turn = next;
  }
}

function startMirror(room) {
  const performer = room.users[crypto.randomInt(2)];
  room.game = { type: 'mirror', status: 'show', performer, round: 1, endsAt: 0, seconds: MIRROR_SECONDS };
  armMirror(room);
}

/** show: performer actúa (90 s) → repeat: el otro lo repite (90 s) → se intercambian los roles */
function armMirror(room) {
  const g = room.game;
  clearTimeout(g.timer);
  g.endsAt = now() + MIRROR_SECONDS * 1000;
  g.timer = setTimeout(() => mirrorAdvance(room), MIRROR_SECONDS * 1000);
}
function mirrorAdvance(room) {
  const g = room.game;
  if (!g || g.type !== 'mirror') return;
  if (g.status === 'show') g.status = 'repeat';
  else {
    g.status = 'show';
    g.performer = other(room, g.performer);
    g.round++;
  }
  armMirror(room);
  sendGame(room);
}

function handleGame(room, uid, m) {
  if (room.phase !== 'open') return;
  switch (m.t) {
    case 'game:propose':
      if (room.game && room.game.status !== 'proposed' && room.game.status !== 'finished') return;
      if (!['oca', 'mirror'].includes(m.game)) return;
      room.game = { type: m.game, status: 'proposed', by: uid };
      break;
    case 'game:accept':
      if (room.game?.status !== 'proposed' || room.game.by === uid) return;
      room.game.type === 'oca' ? startOca(room) : startMirror(room);
      break;
    case 'game:stop':
      clearTimeout(room.game?.timer);
      room.game = null;
      break;
    case 'oca:roll':
      ocaRoll(room, uid);
      break;
    case 'mirror:next': {
      const g = room.game;
      if (g?.type !== 'mirror') return;
      // solo quien está actuando en ese momento puede dar por terminado su turno
      const actor = g.status === 'show' ? g.performer : other(room, g.performer);
      if (actor !== uid) return;
      mirrorAdvance(room);
      return;
    }
    default:
      return;
  }
  sendGame(room);
}

/* ---------------- WebSocket ---------------- */

export function attachRealtime(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    const user = userFromToken(parseCookies(req.headers.cookie).sid);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, user.id));
  });

  function onConnect(ws, uid) {
    if (!sockets.has(uid)) sockets.set(uid, new Set());
    sockets.get(uid).add(ws);
    const room = userRoom.get(uid);
    if (room) {
      clearTimeout(room.grace[uid]);
      pushTo(uid, {
        t: 'room:start',
        roomId: room.id,
        peer: publicUser(getUser(other(room, uid))),
        initiator: room.users[0] === uid,
        phase: room.phase,
        endsAt: room.endsAt,
        game: gameView(room),
        resume: true,
      });
    }
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof m?.t === 'string') onMessage(uid, m);
    });
    ws.on('close', () => {
      const set = sockets.get(uid);
      set?.delete(ws);
      if (set && set.size === 0) {
        sockets.delete(uid);
        leaveQueue(uid);
        const r = userRoom.get(uid);
        if (r) r.grace[uid] = setTimeout(() => rooms.has(r.id) && closeRoom(r, 'peer_disconnected'), GRACE_MS);
      }
    });
  }

  function onMessage(uid, m) {
    const user = getUser(uid);
    if (!user || user.banned) return;
    const room = userRoom.get(uid);

    switch (m.t) {
      case 'queue:join':
        if (room) return;
        if (!hasPremiumAccess(user)) return pushTo(uid, { t: 'error', code: 'premium_required' });
        leaveQueue(uid);
        queue.push({ id: uid, kind: user.kind, mixed: m.mixed === true });
        pushTo(uid, { t: 'queue:joined' });
        return tryMatch();
      case 'queue:leave':
        leaveQueue(uid);
        return pushTo(uid, { t: 'queue:left' });
      case 'rtc':
        // solo se retransmite señalización WebRTC al compañero de sala
        if (room && room.phase !== 'closed') pushTo(other(room, uid), { t: 'rtc', data: m.data });
        return;
      case 'round:decision':
        if (room?.phase !== 'decide' || !['continue', 'pass'].includes(m.choice)) return;
        room.choices[uid] = m.choice;
        if (m.choice === 'pass') return resolveDecision(room);
        pushTo(other(room, uid), { t: 'room:peer_decided' });
        if (room.users.every((u) => room.choices[u])) resolveDecision(room);
        return;
      case 'room:leave':
        if (room) closeRoom(room, 'peer_left');
        return;
      default:
        if (room && /^(game:|oca:|mirror:)/.test(m.t)) handleGame(room, uid, m);
    }
  }

  return wss;
}

export function _resetForTests() {
  queue.length = 0;
  recent.clear();
}
