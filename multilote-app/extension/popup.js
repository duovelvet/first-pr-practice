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

async function refreshStatus() {
  renderRuns();
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
