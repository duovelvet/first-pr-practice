// E2E: la extensión REAL cargada en Chromium + un Supabase simulado + un marketplace simulado (HTTPS local).
//
// Uso:  npm run test:e2e        (necesita Playwright y un Chromium completo; la extensión no carga en headless clásico)
//   PLAYWRIGHT_PATH  ruta/módulo de playwright si no está instalado localmente (p. ej. /opt/node-tools/node_modules/playwright)
//   CHROME_PATH      ejecutable de Chromium/Chrome (opcional; por defecto el de Playwright)
//   DEBUG=1          traza la consola de las pestañas abiertas por la extensión
//
// Los planes de API que se ejercitan son de PRUEBA (los inyecta test-overrides.js solo en la copia temporal):
// los adaptadores reales siguen con api.verified=false hasta tener tráfico real capturado.
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright"));
} catch {
  console.error("Falta Playwright: npm i -D playwright  (o define PLAYWRIGHT_PATH)");
  process.exit(2);
}
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { execFileSync } = require("child_process");

const SRC = process.argv[2] || path.join(__dirname, "../../extension");   // carpeta extension/
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mlext-"));
const EXT = path.join(TMP, "ext");
// Certificado autofirmado efímero para el marketplace simulado (no se versiona ninguna clave).
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(TMP, "key.pem"), "-out", path.join(TMP, "cert.pem"),
  "-days", "2", "-subj", "/CN=es.wallapop.com", "-addext", "subjectAltName=DNS:es.wallapop.com,DNS:api.wallapop.com"], { stdio: "ignore" });
fs.cpSync(SRC, EXT, { recursive: true, filter: (s) => !s.includes("/tools") });

// ---------- estado del simulador ----------
const TOKEN = "TOKEN-ABC123-SECRETO";
const ITEM_ID = "abc123def456", SLUG = "producto-prueba-" + ITEM_ID;
const ITEM_URL = `https://es.wallapop.com/item/${SLUG}`;
const JPG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
const sb = { queue: [], completions: [], seen: [], pubUrl: null };
let sc = {};            // escenario activo
let api = [];           // llamadas recibidas por la API simulada

// ---------- Supabase simulado ----------
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    sb.seen.push(JSON.stringify({ url: req.url, headers: req.headers, body }));
    const u = new URL(req.url, "http://x");
    const json = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/rest/v1/rpc/claim_sync_jobs") return json(sb.queue.splice(0));
    if (u.pathname === "/rest/v1/rpc/complete_sync_job") { sb.completions.push(JSON.parse(body)); return json({}); }
    if (u.pathname === "/rest/v1/listings") return json([{ id: "L1", title: "Producto prueba", description: "desc", price: 12.5, category: "x", photos: ["u1/p1.jpg"] }]);
    if (u.pathname === "/rest/v1/publications") return json([{ external_url: sb.pubUrl }]);
    if (u.pathname.startsWith("/storage/v1/object/sign/") && req.method === "POST") return json({ signedURL: u.pathname.replace("/storage/v1", "") + "?token=t" });
    if (u.pathname.startsWith("/storage/v1/object/sign/")) { res.writeHead(200, { "content-type": "image/jpeg" }); return res.end(JPG); }
    json({}, 404);
  });
});

// ---------- páginas y API del marketplace simulado ----------
const meta = () => `<meta name="ml-test-mode" content="${sc.mode || ""}">`;
const H = { Authorization: `Bearer ${TOKEN}`, "X-DeviceOS": "0" };
const pageUpload = () => `<!doctype html><html><head><meta charset=utf-8>${meta()}</head><body>
<form id=f><input name=title><textarea name=description></textarea><input name=sale_price><input type=file multiple>
<button type=submit>Publicar</button></form>
<script>
fetch('https://api.wallapop.com/api/v3/me',{headers:${JSON.stringify(H)},credentials:'include'});
document.getElementById('f').addEventListener('submit',async(e)=>{e.preventDefault();
  if(${!!sc.submitNoop}) return;
  const r=await fetch('https://api.wallapop.com/api/v3/items',{method:'POST',credentials:'include',headers:{...${JSON.stringify(H)},'X-Page':'1','Content-Type':'application/json'},body:JSON.stringify({title:e.target.title.value})});
  if(r.ok) history.pushState({},'','/item/${SLUG}');});
</script></body></html>`;
const pageItem = () => `<!doctype html><html><head><meta charset=utf-8>${meta()}</head><body><h1>Producto prueba</h1>
<button id=b>Eliminar anuncio</button><button>Eliminar foto 1</button>
<script>
fetch('https://api.wallapop.com/api/v3/me',{headers:${JSON.stringify(H)},credentials:'include'});
document.getElementById('b').onclick=()=>{document.body.insertAdjacentHTML('beforeend','<div role=dialog><p>¿Seguro?</p><button>Cancelar</button><button id=y>Sí, eliminar</button></div>');
 document.getElementById('y').onclick=async()=>{await fetch('https://api.wallapop.com/api/v3/items/${ITEM_ID}',{method:'DELETE',credentials:'include',headers:{...${JSON.stringify(H)},'X-Page':'1'}});history.pushState({},'','/mis-productos');document.getElementById('b').remove();};};
</script></body></html>`;

const cors = (req) => ({
  "access-control-allow-origin": "https://es.wallapop.com", "access-control-allow-credentials": "true",
  "access-control-allow-headers": req.headers["access-control-request-headers"] || "content-type",
  "access-control-allow-methods": "GET,POST,PUT,DELETE", "access-control-expose-headers": "location,content-type",
});

function market(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("latin1");
    const u = new URL(req.url, "https://" + (req.headers.host || "es.wallapop.com"));
    const send = (status, headers, body = "") => { res.writeHead(status, headers); res.end(body); };
    const host = (req.headers.host || "").split(":")[0];
    if (host === "api.wallapop.com") {
      const h = cors(req);
      if (req.method === "OPTIONS") return send(204, h);
      const ours = !("x-page" in req.headers);
      api.push({ method: req.method, path: u.pathname, ours, auth: req.headers["authorization"], os: req.headers["x-deviceos"], ct: req.headers["content-type"] || "", files: (raw.match(/filename=/g) || []).length });
      const J = { ...h, "content-type": "application/json" };
      if (u.pathname === "/api/v3/me") return send(200, J, "{}");
      if (req.method === "POST" && u.pathname === "/api/v3/items") {
        const st = ours ? sc.createStatus || 201 : sc.pageCreateStatus || 201;
        return send(st, J, JSON.stringify(st < 300 ? { id: ITEM_ID, web_slug: SLUG } : { error: "x" }));
      }
      if (req.method === "POST" && u.pathname.endsWith("/pictures")) return send(sc.picStatus || 200, J, "{}");
      if (req.method === "DELETE") return send(ours ? sc.deleteStatus || 204 : 204, h);
      return send(404, h);
    }
    if (u.pathname === "/login") return send(200, { "content-type": "text/html" }, `<html>${meta()}<body>login</body></html>`);
    if (u.pathname.startsWith("/app/catalog/upload")) {
      if (sc.mode && sc.mode.includes("login")) return send(302, { location: "https://es.wallapop.com/login" });
      return send(200, { "content-type": "text/html; charset=utf-8" }, pageUpload());
    }
    if (u.pathname.startsWith("/item/")) return send(200, { "content-type": "text/html; charset=utf-8" }, pageItem());
    send(200, { "content-type": "text/html" }, "<html><body>ok</body></html>");
  });
}
const https = require("https");
const mk = https.createServer({ key: fs.readFileSync(path.join(TMP, "key.pem")), cert: fs.readFileSync(path.join(TMP, "cert.pem")) }, market);

// ---------- preparar copia de la extensión para el simulador ----------
const port = () => server.address().port;
function patchExtension() {
  const cfg = fs.readFileSync(path.join(EXT, "config.js"), "utf8").replace("https://your-project.supabase.co", `http://127.0.0.1:${port()}`);
  fs.writeFileSync(path.join(EXT, "config.js"), cfg);
  const mf = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  mf.host_permissions.push("http://127.0.0.1/*");
  const list = mf.content_scripts[1].js; list.splice(list.indexOf("content.js"), 0, "test-overrides.js");
  fs.writeFileSync(path.join(EXT, "manifest.json"), JSON.stringify(mf, null, 1));
  fs.writeFileSync(path.join(EXT, "test-overrides.js"), `(() => {
    const a = MLAdapters.forHost('es.wallapop.com');
    const mode = document.querySelector('meta[name=ml-test-mode]')?.content || '';
    if (mode.includes('confirm') || mode.includes('api')) a.confirm = { method:'POST', path:/^\\/api\\/v3\\/items\\/?$/, extract:{ id:'id', slug:'web_slug' }, urlTemplate:'https://es.wallapop.com/item/{{slug}}' };
    if (mode.includes('api')) {
      a.idFromUrl = (url) => (/-([a-z0-9]+)$/i.exec(new URL(url).pathname) || [])[1];
      a.api = { verified: true,
        publish: { urlTemplate:'https://es.wallapop.com/item/{{slug}}', steps: [
          { name:'crear', method:'POST', url:'https://api.wallapop.com/api/v3/items', body:{ kind:'json', value:{ title:'{{title}}', price:'{{price}}' } }, extract:{ id:'id', slug:'web_slug' } },
          { name:'fotos', method:'POST', url:'https://api.wallapop.com/api/v3/items/{{id}}/pictures', body:{ kind:'form', fields:{ order:'1' }, files:{ field:'file' } } } ] },
        delete: { steps:[ { name:'borrar', method:'DELETE', url:'https://api.wallapop.com/api/v3/items/{{id}}', expect:[200,204,404] } ] } };
    }
    if (mode.includes('login')) a.loginPath = /^\\/login/;
  })();`);
}

// ---------- ejecución ----------
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => { (cond ? pass++ : fail++); console.log(`   ${cond ? "✔" : "✖"} ${name}${cond ? "" : "  <<<<< " + extra}`); };

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await new Promise((r) => mk.listen(0, "127.0.0.1", r));
  patchExtension();
  const ctx = await chromium.launchPersistentContext(path.join(TMP, "profile"), {
    headless: false, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ["--headless=new", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--ignore-certificate-errors", "--no-proxy-server",
      `--host-resolver-rules=MAP *.wallapop.com 127.0.0.1:${mk.address().port}`],
  });
  const keeper = await ctx.newPage();
  if (process.env.DEBUG) ctx.on("page", (p) => { p.on("console", (m) => console.log("   [page]", m.text().slice(0, 200))); p.on("pageerror", (e) => console.log("   [pageerror]", e.message.slice(0, 200))); });
  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  await sw.evaluate(() => chrome.storage.local.set({ session: { access_token: "sb-access-token", refresh_token: "sb-refresh" } }));

  async function runJob(name, scenario, job) {
    console.log(`\n▶ ${name}`);
    sc = scenario; api = []; sb.completions.length = 0; sb.pubUrl = job.pubUrl || null;
    sb.queue.push({ id: "J-" + name, listing_id: "L1", marketplace: "wallapop", action: job.action, status: "processing", attempts: 1 });
    const r = await sw.evaluate(() => runSync());
    check("la cola entregó 1 tarea (claim_sync_jobs)", r.claimed === 1, JSON.stringify(r));
    const t0 = Date.now();
    while (!sb.completions.length && Date.now() - t0 < (scenario.wait || 60000)) await new Promise((r) => setTimeout(r, 300));
    const done = sb.completions[0];
    check("complete_sync_job recibido", !!done);
    const runs = await sw.evaluate(() => chrome.storage.local.get("runs"));
    return { done, run: (runs.runs || [])[0], badge: await sw.evaluate(() => chrome.action.getBadgeText({})) };
  }
  const closeTabs = async () => { for (const p of ctx.pages()) if (p !== keeper) await p.close().catch(() => {}); };
  const mine = () => api.filter((c) => c.ours && c.path !== "/api/v3/me");
  const pageOwn = () => api.filter((c) => !c.ours && c.path !== "/api/v3/me");

  let o;
  o = await runJob("S1 publicar por API (plan verificado)", { mode: "api" }, { action: "publish" });
  check("éxito, vía API", o.done?.p_success === true && o.run?.via === "api", JSON.stringify(o.done) + JSON.stringify(o.run));
  check("URL final compuesta con lo extraído (id/slug reales)", o.done?.p_external_url === ITEM_URL, o.done?.p_external_url);
  check("la API recibió las cabeceras de sesión de la propia web (Authorization, X-DeviceOS)", mine().every((c) => c.auth === `Bearer ${TOKEN}` && c.os === "0") && mine().length === 2, JSON.stringify(mine()));
  check("creó (JSON) y subió fotos (multipart) sin tocar el formulario", mine()[0]?.ct.includes("json") && mine()[1]?.ct.includes("multipart") && mine()[1].files >= 1 && pageOwn().length === 0, JSON.stringify(api));
  check("no es fallo definitivo", o.done?.p_fatal === false);
  await closeTabs();

  o = await runJob("S2 API responde 401 -> respaldo por DOM", { mode: "api", createStatus: 401 }, { action: "publish" });
  check("éxito, vía DOM tras el 401", o.done?.p_success === true && o.run?.via === "dom", JSON.stringify(o.run));
  check("URL real obtenida del tap sobre la llamada de la web", o.done?.p_external_url === ITEM_URL, o.done?.p_external_url);
  check("1 intento por API (401) + 1 creación de la web", mine().filter((c) => c.path === "/api/v3/items").length === 1 && pageOwn().filter((c) => c.path === "/api/v3/items").length === 1, JSON.stringify(api));
  await closeTabs();

  o = await runJob("S3 API responde 500 tras enviar -> fallo DEFINITIVO, sin duplicar", { mode: "api", createStatus: 500 }, { action: "publish" });
  check("p_success=false y p_fatal=true (la cola NO reintenta)", o.done?.p_success === false && o.done?.p_fatal === true, JSON.stringify(o.done));
  check("se envió UNA sola creación (ni respaldo por DOM ni duplicado)", api.filter((c) => c.path === "/api/v3/items").length === 1, JSON.stringify(api));
  await closeTabs();

  o = await runJob("S4 retirar por API", { mode: "api" }, { action: "delete", pubUrl: ITEM_URL });
  check("éxito, vía API", o.done?.p_success === true && o.run?.via === "api", JSON.stringify(o.run));
  check("DELETE con id extraído de la URL y sesión de la página", mine().length === 1 && mine()[0].path === `/api/v3/items/${ITEM_ID}` && mine()[0].auth === `Bearer ${TOKEN}`, JSON.stringify(api));
  await closeTabs();

  o = await runJob("S5 retirar por API: 404 = ya estaba retirado", { mode: "api", deleteStatus: 404 }, { action: "delete", pubUrl: ITEM_URL });
  check("éxito (idempotente)", o.done?.p_success === true, JSON.stringify(o.done));
  await closeTabs();

  o = await runJob("S6 retirar: API 401 -> respaldo por DOM (botón exacto + diálogo)", { mode: "api", deleteStatus: 401 }, { action: "delete", pubUrl: ITEM_URL });
  check("éxito, vía DOM", o.done?.p_success === true && o.run?.via === "dom", JSON.stringify(o.run));
  check("la web hizo su propio DELETE al confirmar el diálogo", pageOwn().filter((c) => c.method === "DELETE").length === 1, JSON.stringify(api));
  await closeTabs();

  o = await runJob("S7 por defecto (api.verified=false): solo DOM, ninguna llamada a API privada", { mode: "" }, { action: "publish" });
  check("éxito, vía DOM", o.done?.p_success === true && o.run?.via === "dom", JSON.stringify(o.run));
  check("la extensión NO llamó a la API (solo la propia web)", mine().length === 0, JSON.stringify(api));
  check("URL = URL de la pestaña tras publicar", o.done?.p_external_url === ITEM_URL, o.done?.p_external_url);
  await closeTabs();

  o = await runJob("S8 sin sesión (redirige a /login)", { mode: "login" }, { action: "publish" });
  check("fallo NO definitivo (reintento) y avisa de que falta sesión", o.done?.p_success === false && o.done?.p_fatal === false && /Sesión no iniciada/.test(o.done?.p_error || ""), JSON.stringify(o.done));
  check("insignia «!» en el icono", o.badge === "!", o.badge);
  await closeTabs();

  o = await runJob("S9 DOM: la web rechaza la creación (500) detectada por el tap", { mode: "confirm", pageCreateStatus: 500 }, { action: "publish" });
  check("fallo NO definitivo (rechazo limpio)", o.done?.p_success === false && o.done?.p_fatal === false && /HTTP 500/.test(o.done?.p_error || ""), JSON.stringify(o.done));
  await closeTabs();

  o = await runJob("S10 DOM: se pulsa «publicar» y no hay confirmación -> DEFINITIVO", { mode: "", submitNoop: true, wait: 90000 }, { action: "publish" });
  check("p_fatal=true (pudo publicarse: no reintentar)", o.done?.p_success === false && o.done?.p_fatal === true, JSON.stringify(o.done));
  await closeTabs();

  console.log("\n▶ Seguridad: los tokens de sesión del marketplace nunca salen de la página");
  const leaked = sb.seen.filter((s) => s.includes(TOKEN) || s.includes("TOKEN-ABC123"));
  check("ninguna petición a Supabase contiene el token del marketplace", leaked.length === 0, leaked[0]?.slice(0, 200));
  const stor = await sw.evaluate(() => Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null)]));
  check("ni storage.local ni storage.session del worker lo contienen", !JSON.stringify(stor).includes("TOKEN-ABC123"));

  console.log(`\nRESULTADO: ${pass} correctas, ${fail} fallidas`);
  await ctx.close(); server.close(); mk.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR DEL HARNESS:", e); process.exit(2); });
