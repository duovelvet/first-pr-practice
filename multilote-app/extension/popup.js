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

async function refreshStatus() {
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
