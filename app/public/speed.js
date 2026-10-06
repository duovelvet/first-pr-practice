import { h, add, api, toast, mmss, KIND, ageText } from './util.js';

/**
 * Speed dating por videollamada.
 * Estado del cliente: idle → queued → room(round|decide|open) y, en 'open', juegos (oca / espejo).
 */
export function createSpeed({ getMe, send, config }) {
  let root = null;
  let state = { view: 'idle' };
  let pc = null, local = null, pending = [], tick = null;
  // los <video> se crean una vez para que los re-renders no corten la imagen
  const remoteEl = h('video', { autoplay: true, playsInline: true });
  const mixedBox = h('input', { type: 'checkbox' });
  const localEl = h('video', { class: 'self', autoplay: true, muted: true, playsInline: true });

  const render = () => {
    if (!root) return;
    root.replaceChildren();
    add(root, build());
  };

  function build() {
    if (state.view === 'idle') return [lobby()];
    if (state.view === 'queued') {
      return [
        h('div', { class: 'card' },
          h('h2', {}, 'Buscando pareja de speed dating…'),
          h('p', { class: 'mute' }, getMe().kind === 'couple'
            ? 'Te emparejaremos con otra pareja que esté conectada ahora.'
            : 'Te emparejaremos con ' + (getMe().kind === 'woman' ? 'un hombre' : 'una mujer') + ' que esté conectado ahora.'),
          h('button', { class: 'ghost', onclick: () => send({ t: 'queue:leave' }) }, 'Cancelar')),
      ];
    }
    return roomView();
  }

  function lobby() {
    const me = getMe();
    return h('div', { class: 'card' },
      h('h2', {}, 'Speed dating por videollamada'),
      h('p', {}, `Rondas de ${Math.round(config.roundSeconds / 60 * 10) / 10} min. ` +
        (me.kind === 'couple' ? 'Conocerás a otras parejas.' : me.kind === 'woman' ? 'Conocerás a hombres.' : 'Conocerás a mujeres.') +
        ' Al terminar, si los dos elegís seguir, la videollamada continúa y se desbloquean los juegos.'),
      h('label', { class: 'chk' }, mixedBox,
        me.kind === 'couple' ? 'Abrirme también a chicos y chicas (si ellos también lo activan)' : 'Abrirme también a parejas (si ellas también lo activan)'),
      me.premium
        ? h('button', { onclick: startQueue }, 'Entrar en la cola')
        : h('p', {}, 'Necesitas la suscripción premium. ', h('a', { href: '#/premium' }, 'Suscribirme por ' + config.price)),
      h('p', { class: 'mute' }, 'Puedes abandonar en cualquier momento. Nadie debe hacer nada que no quiera.'));
  }

  async function startQueue() {
    try {
      local = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch {
      return toast('Necesitamos permiso de cámara y micrófono');
    }
    send({ t: 'queue:join', mixed: mixedBox.checked });
  }

  function roomView() {
    const r = state.room;
    const left = Math.max(0, Math.round((r.endsAt - Date.now()) / 1000));
    const head = h('div', { class: 'row spread' },
      h('div', {}, h('b', {}, r.peer.display_name), ' ', h('span', { class: 'tag' }, KIND[r.peer.kind]), h('span', { class: 'mute' }, ageText(r.peer))),
      h('div', { class: 'row' },
        r.phase !== 'open' && h('span', { class: 'timer', id: 'clock' }, mmss(left)),
        h('button', { class: 'ghost', onclick: () => confirm('¿Salir de la videollamada?') && send({ t: 'room:leave' }) }, 'Salir'),
        h('button', { class: 'danger', onclick: reportPeer }, 'Reportar')));
    const parts = [h('div', { class: 'card' }, head,
      h('div', { class: 'videos' }, remoteEl, localEl))];
    if (r.phase === 'decide') parts.push(decideCard());
    if (r.phase === 'open') parts.push(gamesCard());
    return parts;
  }

  function decideCard() {
    const r = state.room;
    return h('div', { class: 'card' },
      h('h3', {}, '¿Queréis seguir conociéndoos?'),
      r.myChoice
        ? h('p', {}, r.myChoice === 'continue' ? 'Esperando a la otra parte…' : 'Has pasado.')
        : h('div', { class: 'row' },
          h('button', { onclick: () => choose('continue') }, '💜 Seguir'),
          h('button', { class: 'ghost', onclick: () => choose('pass') }, 'Pasar')),
      r.peerDecided && h('p', { class: 'mute' }, 'La otra parte ya ha decidido.'));
  }
  function choose(c) {
    state.room.myChoice = c;
    send({ t: 'round:decision', choice: c });
    render();
  }
  async function reportPeer() {
    const reason = prompt('¿Qué ha pasado?');
    if (!reason) return;
    await api('POST', `/report/${state.room.peer.id}`, { reason }).catch((e) => toast(e.message));
    toast('Reporte enviado. Puedes salir de la llamada cuando quieras.');
  }

  /* ---------- Juegos ---------- */
  function gamesCard() {
    const g = state.room.game;
    const me = getMe();
    const card = h('div', { class: 'card' }, h('h3', {}, '¡Match! Seguid jugando'));
    if (!g) {
      add(card, 
        h('p', { class: 'mute' }, 'Cualquiera puede proponer un juego; el otro lado debe aceptar y puede pararlo cuando quiera.'),
        h('div', { class: 'row' },
          h('button', { onclick: () => send({ t: 'game:propose', game: 'oca' }) }, '🎲 Juego de la oca'),
          h('button', { onclick: () => send({ t: 'game:propose', game: 'mirror' }) }, '🪞 El espejo (90 s)')));
    } else if (g.status === 'proposed') {
      const mine = g.by === me.id;
      add(card, h('p', {}, mine ? 'Esperando a que acepten…' : `Te proponen jugar a ${g.type === 'oca' ? 'la oca' : 'el espejo'}.`),
        h('div', { class: 'row' },
          !mine && h('button', { onclick: () => send({ t: 'game:accept' }) }, 'Aceptar'),
          h('button', { class: 'ghost', onclick: () => send({ t: 'game:stop' }) }, mine ? 'Cancelar' : 'Rechazar')));
    } else if (g.type === 'oca') add(card, ocaView(g, me));
    else add(card, mirrorView(g, me));
    return card;
  }

  function ocaView(g, me) {
    const peerId = state.room.peer.id;
    const board = h('div', { class: 'board' }, config.board.tiles.map((t) =>
      h('div', { class: `tile ${t.type}`, title: t.text }, t.n,
        h('div', { class: 'tok' },
          g.pos[me.id] === t.n && h('i', { class: 'a', title: 'Tú' }),
          g.pos[peerId] === t.n && h('i', { class: 'b', title: state.room.peer.display_name })))));
    const myTurn = g.turn === me.id;
    const last = g.last;
    return h('div', {},
      board,
      last && h('p', { class: 'bigtxt' }, `${last.by === me.id ? 'Sacaste' : state.room.peer.display_name + ' sacó'} un ${last.roll} → casilla ${last.pos}`),
      last?.notes.map((n) => h('p', {}, n)),
      g.status === 'finished'
        ? h('p', { class: 'bigtxt' }, g.winner === me.id ? '🏆 ¡Has ganado!' : '🏆 Ha ganado la otra parte')
        : h('div', { class: 'row' },
          h('button', { disabled: !myTurn, onclick: () => send({ t: 'oca:roll' }) }, myTurn ? '🎲 Tirar dado' : 'Turno de la otra parte'),
          h('button', { class: 'ghost', onclick: () => send({ t: 'game:stop' }) }, 'Terminar juego')),
      g.status === 'finished' && h('button', { class: 'ghost', onclick: () => send({ t: 'game:stop' }) }, 'Cerrar'));
  }

  function mirrorView(g, me) {
    const iPerform = g.performer === me.id;
    const actor = g.status === 'show' ? iPerform : !iPerform;
    const left = Math.max(0, Math.round((g.endsAt - Date.now()) / 1000));
    const text = g.status === 'show'
      ? (iPerform ? '🎬 Te toca: haz algo, la otra parte te observa' : '👀 Observa con atención…')
      : (iPerform ? '👀 Ahora te toca mirar cómo lo repiten' : '🪞 Ahora repite lo que has visto');
    return h('div', {},
      h('p', { class: 'mute' }, `Ronda ${g.round}`),
      h('p', { class: 'bigtxt' }, text),
      h('div', { class: 'timer', id: 'mclock' }, mmss(left)),
      h('div', { class: 'row' },
        actor && h('button', { onclick: () => send({ t: 'mirror:next' }) }, 'He terminado'),
        h('button', { class: 'ghost', onclick: () => send({ t: 'game:stop' }) }, 'Parar juego')));
  }

  /* ---------- WebRTC ---------- */
  async function startCall() {
    if (!local) local = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    pc = new RTCPeerConnection({ iceServers: config.iceServers });
    local.getTracks().forEach((t) => pc.addTrack(t, local));
    pc.ontrack = (e) => { remoteEl.srcObject = e.streams[0]; };
    pc.onicecandidate = (e) => e.candidate && send({ t: 'rtc', data: { candidate: e.candidate } });
    for (const d of pending.splice(0)) await onSignal(d);
    if (state.room.initiator) {
      await pc.setLocalDescription(await pc.createOffer());
      send({ t: 'rtc', data: { sdp: pc.localDescription } });
    }
    attachStreams();
  }
  async function onSignal(d) {
    if (!pc) return pending.push(d);
    if (d.sdp) {
      await pc.setRemoteDescription(d.sdp);
      if (d.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        send({ t: 'rtc', data: { sdp: pc.localDescription } });
      }
    } else if (d.candidate) await pc.addIceCandidate(d.candidate).catch(() => {});
  }
  function attachStreams() {
    if (local && localEl.srcObject !== local) localEl.srcObject = local;
  }
  function endCall() {
    pc?.close();
    pc = null;
    pending = [];
    local?.getTracks().forEach((t) => t.stop());
    local = null;
    localEl.srcObject = remoteEl.srcObject = null;
    clearInterval(tick);
  }

  function startTicker() {
    clearInterval(tick);
    tick = setInterval(() => {
      const c = document.getElementById('clock');
      if (c && state.room) c.textContent = mmss(Math.max(0, Math.round((state.room.endsAt - Date.now()) / 1000)));
      const m = document.getElementById('mclock');
      if (m && state.room?.game?.endsAt) m.textContent = mmss(Math.max(0, Math.round((state.room.game.endsAt - Date.now()) / 1000)));
    }, 500);
  }

  /* ---------- API pública ---------- */
  return {
    mount(el) {
      root = el;
      render();
      attachStreams();
    },
    unmount() { root = null; },
    active: () => state.view !== 'idle',
    async onMessage(m) {
      switch (m.t) {
        case 'queue:joined': state = { view: 'queued' }; break;
        case 'queue:left': endCall(); state = { view: 'idle' }; break;
        case 'room:start':
          state = { view: 'room', room: { ...m, game: m.game || null } };
          startTicker();
          render();
          if (!pc) await startCall().catch(() => toast('No se pudo iniciar la cámara'));
          attachStreams();
          return;
        case 'room:phase':
          Object.assign(state.room, { phase: m.phase, endsAt: m.endsAt });
          if (m.matched) toast('¡Es un match! 💜');
          break;
        case 'room:peer_decided': state.room.peerDecided = true; break;
        case 'room:end':
          endCall();
          toast(m.reason === 'no_match' ? 'La ronda terminó sin match' : 'La videollamada ha terminado');
          state = { view: 'idle' };
          break;
        case 'game:state': state.room.game = m.game; break;
        case 'rtc': return onSignal(m.data);
        case 'error':
          if (m.code === 'premium_required') { toast('Necesitas la suscripción premium'); endCall(); state = { view: 'idle' }; }
          break;
        default: return;
      }
      render();
      attachStreams();
    },
  };
}
