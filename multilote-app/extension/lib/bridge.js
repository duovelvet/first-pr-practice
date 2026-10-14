// Puente (content script, mundo aislado) hacia page-hook.js (mundo principal de la página).
// Ver page-hook.js para el modelo de confianza: el canal no es de confianza y aquí NUNCA llegan tokens.
const MLBridge = (() => {
  const TAG = "multilote-hook-v1";
  const pending = new Map(); // reqId -> resolve (llamadas a la API)
  const tapWaiters = new Map(); // tapId -> resolve
  let seq = 0;
  let ready = false;
  let authSeen = false;
  let readyWaiters = [];

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d[TAG] !== true || d.dir !== "to-content") return;
    if (d.type === "pong") {
      ready = true;
      authSeen = authSeen || !!d.authSeen;
      readyWaiters.splice(0).forEach((r) => r(true));
    } else if (d.type === "api-result" && pending.has(d.reqId)) {
      pending.get(d.reqId)(d.result);
      pending.delete(d.reqId);
    } else if (d.type === "tap-hit" && tapWaiters.has(d.id)) {
      tapWaiters.get(d.id)({ status: d.status, extracted: d.extracted || {} });
      tapWaiters.delete(d.id);
    }
  });

  const send = (msg) => window.postMessage({ [TAG]: true, dir: "to-hook", ...msg }, location.origin);

  // Espera a que el gancho responda (si el navegador no soporta world MAIN, nunca responde: devolvemos false).
  async function whenReady(timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      send({ cmd: "ping" });
      if (ready) return true;
      const ok = await new Promise((resolve) => {
        readyWaiters.push(resolve);
        setTimeout(() => resolve(false), 300);
      });
      if (ok) return true;
    }
    return false;
  }

  // La sesión se detecta cuando la web hace su primera llamada autenticada; esperamos a que ocurra.
  async function waitForSession(timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      send({ cmd: "ping" });
      await new Promise((r) => setTimeout(r, 300));
      if (authSeen) return true;
    }
    return authSeen;
  }

  // Llama a la API del marketplace desde el contexto de la página con la sesión del usuario.
  function api(req, timeoutMs = 40000) {
    return new Promise((resolve) => {
      const reqId = `r${++seq}-${Date.now()}`;
      const t = setTimeout(() => {
        pending.delete(reqId);
        resolve({ sent: true, error: "timeout", message: "sin respuesta del gancho" });
      }, timeoutMs);
      pending.set(reqId, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      send({ cmd: "api", reqId, req });
    });
  }

  // Registra un tap y devuelve { promise, cancel }. La promesa se resuelve con { status, extracted } o null al caducar.
  function expectTap(spec, timeoutMs = 30000) {
    const id = `t${++seq}-${Date.now()}`;
    const promise = new Promise((resolve) => {
      const t = setTimeout(() => {
        tapWaiters.delete(id);
        send({ cmd: "untap", id });
        resolve(null);
      }, timeoutMs);
      tapWaiters.set(id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
    });
    send({
      cmd: "tap",
      id,
      spec: {
        method: spec.method,
        pathSource: spec.path instanceof RegExp ? spec.path.source : spec.path,
        flags: spec.path instanceof RegExp ? spec.path.flags : "",
        extract: spec.extract,
        once: true,
      },
    });
    return {
      promise,
      cancel: () => {
        tapWaiters.delete(id);
        send({ cmd: "untap", id });
      },
    };
  }

  return { whenReady, waitForSession, api, expectTap };
})();
