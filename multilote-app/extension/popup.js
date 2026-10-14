const $ = (id) => document.getElementById(id);

async function showApp() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("openWeb").href = `${MULTILOTE_CONFIG.WEB_URL}/dashboard`;
  await refreshStatus();
}

function showLogin() {
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
}

const ACTION_ES = { publish: "publicar", delete: "retirar", update: "actualizar" };

async function renderRuns() {
  const { runs = [] } = await chrome.storage.local.get("runs");
  $("runsBox").classList.toggle("hidden", runs.length === 0);
  const ul = $("runs");
  ul.textContent = "";
  for (const r of runs.slice(0, 5)) {
    const li = document.createElement("li");
    li.style.padding = "3px 0";
    const when = new Date(r.t).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
    li.textContent = `${r.ok ? "✔" : "✖"} ${when} · ${r.marketplace} · ${ACTION_ES[r.action] || r.action}` +
      (r.ok && r.via ? ` (${r.via})` : "") + (r.ok ? "" : ` — ${r.fatal ? "REVISAR: " : ""}${r.error}`);
    li.style.color = r.ok ? "#166534" : r.fatal ? "#b91c1c" : "#92400e";
    ul.appendChild(li);
  }
}

// ---- Modo API: aprender / verificar ---------------------------------------------------------------------------
const MARKETS = [["wallapop", "Wallapop"], ["todocoleccion", "Todocolección"], ["vinted", "Vinted"], ["milanuncios", "Milanuncios"]];
const call = (msg) => chrome.runtime.sendMessage(msg);

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function button(label, onClick, secondary) {
  const b = el("button", label, secondary ? "secondary" : "");
  b.style.marginRight = "6px";
  b.onclick = async () => {
    b.disabled = true;
    try {
      await onClick();
    } finally {
      await renderApi();
    }
  };
  return b;
}

let autoTimer = null;

// Resultado del último aprendizaje automático de este marketplace.
function autoNote(wrap, last) {
  if (!last) return;
  if (last.ok) {
    wrap.append(el("p", last.verifying ? "✔ Aprendido solo. Verificando por API…" : "✔ Aprendido solo (borrador).", "ok"));
    for (const w of last.warnings || []) wrap.append(el("p", "⚠ " + w, "warn"));
  } else {
    wrap.append(el("p", `✖ Aprendizaje automático: ${last.error}${last.orphan ? " — REVISA si quedó un anuncio de prueba" + (last.url ? ": " + last.url : "") : ""}`, "bad"));
  }
}

async function renderApi() {
  const { profiles = {}, rec, auto, autoLast = {} } = (await call({ type: "profiles-get" })) || {};
  clearTimeout(autoTimer);
  if (auto) autoTimer = setTimeout(renderApi, 2000); // mientras aprende solo, refresca el estado
  const box = $("apiList");
  box.textContent = "";
  for (const [id, name] of MARKETS) {
    const p = profiles[id];
    const wrap = el("div", null, "mk");
    wrap.append(el("h3", name));

    if (auto && auto.marketplace === id) {
      wrap.append(el("p", `⏳ Aprendiendo solo: ${auto.stage}. No cierres la pestaña que se abrió.`, "warn"));
    } else if (rec && rec.marketplace === id) {
      wrap.append(el("p", "● Grabando. En la pestaña que se abrió, usa EXACTAMENTE estos valores:", "warn"));
      const ul = el("ul");
      ul.append(el("li", `Título: ${rec.sentinels.title}`), el("li", `Descripción: ${rec.sentinels.description}`), el("li", `Precio: ${rec.sentinels.price}`));
      ul.append(el("li", "Sube UNA foto, publica, abre el anuncio y ELIMÍNALO."));
      wrap.append(ul);
      wrap.append(button("Terminar y analizar", async () => {
        const r = await call({ type: "rec-stop" });
        if (r.error || r.ok === false) alert("No se pudo deducir el perfil:\n" + ((r.error && (r.error.message || r.error)) || "") + "\n" + ((r.report && r.report.warnings) || []).join("\n"));
      }));
    } else if (!p) {
      wrap.append(el("p", "Sin perfil: se usa la página (DOM).", "muted"));
      autoNote(wrap, autoLast[id]);
      wrap.append(button("Aprender solo y verificar", async () => {
        if (!confirm(`Se publicará y se borrará un anuncio de prueba REAL (MLTEST-…) en tu cuenta de ${name}, y luego otro para verificar. ¿Continuar?`)) return;
        const r = await call({ type: "autolearn-start", marketplace: id, verify: true });
        if (r && r.error) alert(r.error);
      }));
      wrap.append(button("Aprender a mano", async () => { await call({ type: "rec-start", marketplace: id }); }, true));
    } else {
      const st = p.status;
      autoNote(wrap, autoLast[id]);
      wrap.append(el("p", st === "verified" ? "✔ Verificado: usa la API" : st === "stale" ? "⚠ Desactivado: el sitio respondió distinto" : "Perfil aprendido, sin verificar (se usa la página)", st === "verified" ? "ok" : "warn"));
      if (st === "stale" && p.staleReason) wrap.append(el("p", p.staleReason, "muted"));
      const pub = p.api && p.api.publish;
      const baked = (pub && pub.bakedFields) || [];
      if (pub) {
        wrap.append(el("p", `Publicar: ${pub.steps.length} paso(s)${pub.photos ? ", con fotos" : ", SIN fotos (esos anuncios van por la página)"}. Retirar: ${p.api.delete ? "sí" : "no aprendido"}.`, "muted"));
      }
      if (baked.length) {
        wrap.append(el("p", "Se copiarían del anuncio de prueba a TODOS los anuncios:", "muted"));
        const ul = el("ul");
        ul.append(...baked.slice(0, 8).map((b) => el("li", `${b.path} = ${b.value}`)), ...(baked.length > 8 ? [el("li", `… y ${baked.length - 8} más`)] : []));
        wrap.append(ul);
        const lab = el("label", " Entiendo que la categoría/envío/ubicación serán los de la prueba");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.style.width = "auto";
        cb.checked = !!(p.consent && p.consent.baked);
        cb.onchange = async () => { await call({ type: "profile-consent", marketplace: id, baked: cb.checked }); };
        lab.prepend(cb);
        wrap.append(lab);
      }
      if (p.lastSelftest && !p.lastSelftest.ok) {
        wrap.append(el("p", `Autoprueba fallida: ${p.lastSelftest.error}${p.lastSelftest.orphan ? " — REVISA si quedó un anuncio de prueba" + (p.lastSelftest.url ? ": " + p.lastSelftest.url : "") : ""}`, "bad"));
      }
      for (const w of p.warnings || []) wrap.append(el("p", "⚠ " + w, "warn"));
      if (st !== "verified") {
        wrap.append(button("Verificar con anuncio de prueba", async () => {
          const r = await call({ type: "selftest-start", marketplace: id });
          if (r && r.error) alert(r.error);
        }));
      }
      wrap.append(button(st === "verified" ? "Desactivar y olvidar" : "Volver a aprender", async () => {
        await call({ type: "profile-delete", marketplace: id });
        if (st !== "verified") await call({ type: "rec-start", marketplace: id });
      }, true));
    }
    box.append(wrap);
  }
}

async function refreshStatus() {
  renderRuns();
  renderApi();
  try {
    const rows = await ML.select("sync_queue?status=in.(pending,processing)&select=id,status");
    const pending = rows.filter((r) => r.status === "pending").length;
    const processing = rows.length - pending;
    $("status").textContent = rows.length
      ? `${pending} en cola · ${processing} en curso`
      : "No hay tareas pendientes.";
  } catch (e) {
    if (e.message === "no-session") return showLogin();
    $("status").textContent = "No se pudo leer la cola.";
  }
}

$("login").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  try {
    await ML.login($("email").value, $("password").value);
    await showApp();
    chrome.runtime.sendMessage({ type: "sync-now" });
  } catch (err) {
    $("loginError").textContent = err.message;
  }
});

$("logout").addEventListener("click", async () => {
  await ML.logout();
  showLogin();
});

$("syncNow").addEventListener("click", async () => {
  $("syncNow").disabled = true;
  const res = await chrome.runtime.sendMessage({ type: "sync-now" });
  $("status").textContent = res?.error ? `Error: ${res.error}` : `${res?.claimed ?? 0} tarea(s) iniciadas.`;
  $("syncNow").disabled = false;
});

(async () => {
  if (await ML.getSession()) await showApp();
  else showLogin();
})();
