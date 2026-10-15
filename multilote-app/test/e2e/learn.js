// E2E del APRENDIZAJE de endpoints: grabar -> sintetizar -> verificar (autoprueba) -> usar desde la cola -> degradar.
// Carga la extensión REAL en Chromium. Dos marketplaces simulados que se comportan como webs reales:
//   · «Wallapop»: API JSON con sesión (Authorization), foto subida aparte, SPA. VALIDA lo que recibe (422 si no cuadra).
//   · «Todocolección»: formularios clásicos, cookie de sesión, CSRF de un solo uso y redirecciones.
// Los sitios son simulados: lo que se demuestra es que la tubería deduce y valida los esquemas SIN intervención manual
// en la consola; los esquemas reales de los sitios reales se obtienen grabando una vez en el navegador del usuario.
//
// Uso: npm run test:e2e:learn   (mismas variables que test/e2e/run.js: PLAYWRIGHT_PATH, CHROME_PATH, DEBUG)
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright"));
} catch {
  console.error("Falta Playwright: npm i -D playwright  (o define PLAYWRIGHT_PATH)");
  process.exit(2);
}
const http = require("http"), https = require("https"), fs = require("fs"), path = require("path"), os = require("os");
const { execFileSync } = require("child_process");

const SRC = process.argv[2] || path.join(__dirname, "../../extension");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mllearn-"));
const EXT = path.join(TMP, "ext");
fs.cpSync(SRC, EXT, { recursive: true, filter: (s) => !s.includes("/tools") });
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(TMP, "key.pem"), "-out", path.join(TMP, "cert.pem"), "-days", "2",
  "-subj", "/CN=es.wallapop.com", "-addext", "subjectAltName=DNS:es.wallapop.com,DNS:api.wallapop.com,DNS:www.todocoleccion.net"], { stdio: "ignore" });

const TOKEN = "TOKEN-WLP-SECRETO-9d8c7b";
const JPG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = (n = 6) => Math.random().toString(36).slice(2, 2 + n);

// =============================================================================================================
// Supabase simulado
// =============================================================================================================
const sb = { queue: [], completions: [], seen: [], pubUrl: null };
const supa = http.createServer((req, res) => {
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
    if (u.pathname === "/rest/v1/sync_queue") return json([]);
    if (u.pathname.startsWith("/storage/v1/object/sign/") && req.method === "POST") return json({ signedURL: u.pathname.replace("/storage/v1", "") + "?token=t" });
    if (u.pathname.startsWith("/storage/v1/object/sign/")) { res.writeHead(200, { "content-type": "image/jpeg" }); return res.end(JPG); }
    json({}, 404);
  });
});

// =============================================================================================================
// Utilidades de los sitios simulados
// =============================================================================================================
function parseMultipart(buf, contentType) {
  const m = /boundary=(.+)$/.exec(contentType || "");
  const out = { fields: {}, files: [] };
  if (!m) return out;
  for (const part of buf.toString("latin1").split("--" + m[1])) {
    const i = part.indexOf("\r\n\r\n");
    if (i < 0) continue;
    const head = part.slice(0, i), content = part.slice(i + 4).replace(/\r\n$/, "");
    const name = /name="([^"]*)"/.exec(head);
    if (!name) continue;
    const fn = /filename="([^"]*)"/.exec(head);
    if (fn) out.files.push({ field: name[1], filename: fn[1], size: content.length });
    else out.fields[name[1]] = content;
  }
  return out;
}
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---------------------------------------------------------------------------------------------------------------
// «Wallapop» (API JSON)
// ---------------------------------------------------------------------------------------------------------------
const W = { pics: new Set(), items: new Map(), needNewField: false, noForm: false, log: [] };
const APIH = JSON.stringify({ Authorization: `Bearer ${TOKEN}`, "X-DeviceOS": "0" });

// Vista del anuncio, compartida por la SPA (tras publicar, sin recargar) y por la carga directa de /item/<slug>.
const ITEM_JS = `function showItem(id){
 document.body.innerHTML='<h1>Producto</h1><button id=b>Eliminar anuncio</button>';
 document.getElementById('b').onclick=()=>{document.body.insertAdjacentHTML('beforeend','<div role=dialog><button>Cancelar</button><button id=y>Sí, eliminar</button></div>');
  document.getElementById('y').onclick=async()=>{await fetch(API+'/api/v3/items/'+id,{method:'DELETE',credentials:'include',headers:{...H,'X-Page':'1'}});
   history.pushState({},'','/mis-productos');document.body.innerHTML='<h1>Mis productos</h1>';};};}`;
const wPageUpload = () => `<!doctype html><html><head><meta charset=utf-8></head><body>
<form id=f><input name=title><textarea name=description></textarea><input name=sale_price><input type=file name=photo>
<button type=submit>Publicar</button></form>
<script>
const API='https://api.wallapop.com', H=${APIH};
${ITEM_JS}
fetch(API+'/api/v3/me',{headers:H,credentials:'include'});
f.addEventListener('submit',async(e)=>{e.preventDefault();
  const file=f.photo.files[0]; let pics=[];
  if(file){const fd=new FormData(); fd.append('file',file); fd.append('type','item');
    const r=await fetch(API+'/api/v3/pictures',{method:'POST',credentials:'include',headers:{...H,'X-Page':'1'},body:fd}); pics=[(await r.json()).id];}
  const body={title:f.title.value,description:f.description.value,sale_price:{amount:Number(f.sale_price.value),currency:'EUR'},category_leaf_id:'100',pictures:pics,location:{latitude:41.3851,longitude:2.1734,postal_code:'08001'},negotiable:false};
  ${W.needNewField ? "body.accepts_terms=true;" : ""}
  const r=await fetch(API+'/api/v3/items',{method:'POST',credentials:'include',headers:{...H,'X-Page':'1','Content-Type':'application/json'},body:JSON.stringify(body)});
  if(r.ok){const j=await r.json(); history.pushState({},'','/item/'+j.web_slug); showItem(j.id);}
});
</script></body></html>`;
const wPageItem = (id) => W.items.has(id)
  ? `<!doctype html><html><head><meta charset=utf-8></head><body><script>const API='https://api.wallapop.com',H=${APIH};${ITEM_JS}
fetch(API+'/api/v3/me',{headers:H,credentials:'include'});showItem('${id}');</script></body></html>`
  : `<!doctype html><html><head><meta charset=utf-8></head><body><h1>Este anuncio ya no está disponible</h1></body></html>`;

function wallapop(req, res, raw) {
  const u = new URL(req.url, "https://x");
  const host = (req.headers.host || "").split(":")[0];
  const send = (st, h, b = "") => { res.writeHead(st, h); res.end(b); };
  if (host === "api.wallapop.com") {
    const cors = { "access-control-allow-origin": "https://es.wallapop.com", "access-control-allow-credentials": "true", "access-control-allow-headers": req.headers["access-control-request-headers"] || "content-type", "access-control-allow-methods": "GET,POST,PUT,DELETE", "access-control-expose-headers": "location,content-type" };
    const J = { ...cors, "content-type": "application/json" };
    if (req.method === "OPTIONS") return send(204, cors);
    const ours = !("x-page" in req.headers);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, J, "{}");
    W.log.push({ method: req.method, path: u.pathname, ours, ct: req.headers["content-type"] || "" });
    if (u.pathname === "/api/v3/me") return send(200, J, "{}");
    if (req.method === "POST" && u.pathname === "/api/v3/pictures") {
      const mp = parseMultipart(raw, req.headers["content-type"]);
      if (!mp.files.length || !mp.files[0].size) return send(422, J, '{"error":"no file"}');
      const id = "pic" + rid(8); W.pics.add(id); return send(200, J, JSON.stringify({ id }));
    }
    if (req.method === "POST" && u.pathname === "/api/v3/items") {
      let b; try { b = JSON.parse(raw.toString()); } catch { return send(400, J, "{}"); }
      const ok = typeof b.title === "string" && b.title && b.sale_price && typeof b.sale_price.amount === "number" && typeof b.category_leaf_id === "string"
        && Array.isArray(b.pictures) && b.pictures.every((p) => W.pics.has(p)) && b.location && typeof b.location.latitude === "number"
        && (!W.needNewField || b.accepts_terms === true);
      if (!ok) return send(422, J, '{"error":"validation"}');
      const id = "k" + String(Math.floor(100000 + Math.random() * 900000)) + "x" + rid(4);
      const slug = slugify(b.title) + "-" + id;
      W.items.set(id, { ...b, slug, ours });
      return send(201, J, JSON.stringify({ id, web_slug: slug }));
    }
    const del = /^\/api\/v3\/items\/([^/]+)$/.exec(u.pathname);
    if (req.method === "DELETE" && del) return W.items.delete(del[1]) ? send(204, cors) : send(404, J, "{}");
    return send(404, J, "{}");
  }
  if (W.noForm && u.pathname.startsWith("/app/catalog/upload")) return send(200, { "content-type": "text/html; charset=utf-8" }, "<html><body><h1>Sitio rediseñado</h1></body></html>");
  if (u.pathname.startsWith("/app/catalog/upload")) return send(200, { "content-type": "text/html; charset=utf-8" }, wPageUpload());
  const it = /^\/item\/(.+)$/.exec(u.pathname);
  if (it) return send(200, { "content-type": "text/html; charset=utf-8" }, wPageItem(it[1].split("-").pop()));
  send(200, { "content-type": "text/html; charset=utf-8" }, "<html><body>ok</body></html>");
}

// ---------------------------------------------------------------------------------------------------------------
// «Todocolección» (formularios clásicos, cookie, CSRF de un solo uso, redirecciones)
// ---------------------------------------------------------------------------------------------------------------
const T = { sessions: new Map(), lotes: new Map(), log: [] };
function tSession(req, res) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || "");
  let sid = m && T.sessions.has(m[1]) ? m[1] : null;
  if (!sid) { sid = "S" + rid(10); T.sessions.set(sid, new Set()); res.setHeader("Set-Cookie", `sid=${sid}; Path=/; SameSite=Lax`); }
  return sid;
}
const tToken = (sid) => { const t = "csrf-" + rid(12); T.sessions.get(sid).add(t); return t; };
const tCsrfOk = (sid, t) => { const s = T.sessions.get(sid); return !!(s && t && s.delete(t)); };

function todocoleccion(req, res, raw) {
  const u = new URL(req.url, "https://x");
  const html = (st, body) => { res.writeHead(st, { ...(res.getHeader("Set-Cookie") ? { "Set-Cookie": res.getHeader("Set-Cookie") } : {}), "content-type": "text/html; charset=utf-8" }); res.end(`<!doctype html><html><head><meta charset=utf-8></head><body>${body}</body></html>`); };
  const redirect = (to) => { res.writeHead(302, { Location: to, ...(res.getHeader("Set-Cookie") ? { "Set-Cookie": res.getHeader("Set-Cookie") } : {}) }); res.end(); };
  const sid = tSession(req, res);
  T.log.push({ method: req.method, path: u.pathname, ct: req.headers["content-type"] || "" });

  if (req.method === "GET" && u.pathname === "/vender") {
    return html(200, `<form method=post action=/vender enctype=multipart/form-data>
<input type=hidden name=csrf_token value="${tToken(sid)}"><input name=titulo><textarea name=descripcion></textarea><input name=precio>
<select name=categoria><option value=monedas>Monedas</option></select><input type=file name=foto><button type=submit>Publicar</button></form>`);
  }
  if (req.method === "POST" && u.pathname === "/vender") {
    const mp = parseMultipart(raw, req.headers["content-type"]);
    const f = mp.fields;
    if (!tCsrfOk(sid, f.csrf_token)) return html(403, "CSRF inválido");
    if (!f.titulo || !/^\d+([.,]\d+)?$/.test(f.precio || "") || !f.categoria || !mp.files.some((x) => x.field === "foto" && x.size > 0)) return html(400, "Faltan datos");
    const id = String(Math.floor(100000000 + Math.random() * 900000000));
    T.lotes.set(id, { titulo: f.titulo, precio: f.precio, categoria: f.categoria });
    return redirect("/lote/" + id);
  }
  const lote = /^\/lote\/(\d+)$/.exec(u.pathname);
  if (req.method === "GET" && lote) {
    if (!T.lotes.has(lote[1])) return html(404, "<h1>Este lote ya no está disponible</h1>");
    return html(200, `<h1>Lote</h1><form method=post action="/lote/${lote[1]}/eliminar"><input type=hidden name=csrf_token value="${tToken(sid)}"><input type=hidden name=motivo value=vendido><button type=submit>Eliminar</button></form>`);
  }
  const del = /^\/lote\/(\d+)\/eliminar$/.exec(u.pathname);
  if (req.method === "POST" && del) {
    const f = Object.fromEntries(new URLSearchParams(raw.toString()));
    if (!tCsrfOk(sid, f.csrf_token)) return html(403, "CSRF inválido");
    if (!T.lotes.delete(del[1])) return html(404, "No existe");
    return redirect("/mis-lotes");
  }
  html(200, '<h1>Mis lotes</h1><nav><a href="/ayuda">Ayuda</a> <a href="/vender">Vender un lote</a></nav>');
}

const mk = https.createServer({ key: fs.readFileSync(path.join(TMP, "key.pem")), cert: fs.readFileSync(path.join(TMP, "cert.pem")) }, (req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const host = (req.headers.host || "").split(":")[0];
    try { return host.endsWith("todocoleccion.net") ? todocoleccion(req, res, raw) : wallapop(req, res, raw); }
    catch (e) { console.error("sim error", e); res.writeHead(500); res.end(); }
  });
});

// =============================================================================================================
// Ejecución
// =============================================================================================================
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => { (cond ? pass++ : fail++); console.log(`   ${cond ? "✔" : "✖"} ${name}${cond ? "" : "  <<<<< " + String(extra).slice(0, 400)}`); };
const until = async (fn, ms = 60000, step = 250) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };

(async () => {
  await new Promise((r) => supa.listen(0, "127.0.0.1", r));
  await new Promise((r) => mk.listen(0, "127.0.0.1", r));
  const cfgPath = path.join(EXT, "config.js");
  fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, "utf8")
    .replace("https://your-project.supabase.co", `http://127.0.0.1:${supa.address().port}`));
  // OJO: la URL de subida de Todocolección en config.js es un marcador (la portada). El perfil debe aprender la real.
  const mf = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  mf.host_permissions.push("http://127.0.0.1/*");
  fs.writeFileSync(path.join(EXT, "manifest.json"), JSON.stringify(mf, null, 1));

  const P = mk.address().port;
  const ctx = await chromium.launchPersistentContext(path.join(TMP, "profile"), {
    headless: false, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ["--headless=new", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--ignore-certificate-errors", "--no-proxy-server",
      `--host-resolver-rules=MAP *.wallapop.com 127.0.0.1:${P}, MAP *.todocoleccion.net 127.0.0.1:${P}`],
  });
  const keeper = await ctx.newPage();
  if (process.env.DEBUG) ctx.on("page", (p) => p.on("console", (m) => console.log("   [page]", m.text().slice(0, 200))));
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ session: { access_token: "sb-access-token", refresh_token: "sb-refresh" } }));

  const profile = (id) => sw.evaluate((i) => MLProfiles.load(i), id);
  const closeTabs = async () => { for (const p of ctx.pages()) if (p !== keeper) await p.close().catch(() => {}); };
  const findPage = (re) => until(() => ctx.pages().find((p) => re.test(p.url())), 15000);

  async function runJob(name, marketplace, action, pubUrl) {
    console.log(`\n▶ ${name}`);
    sb.completions.length = 0; sb.pubUrl = pubUrl || null;
    sb.queue.push({ id: "J-" + name, listing_id: "L1", marketplace, action, status: "processing", attempts: 1 });
    const r = await sw.evaluate(() => runSync());
    check("la cola entregó 1 tarea", r.claimed === 1, JSON.stringify(r));
    await until(() => sb.completions.length, 90000);
    const done = sb.completions[0];
    check("complete_sync_job recibido", !!done);
    const runs = await sw.evaluate(() => chrome.storage.local.get("runs"));
    await closeTabs();
    return { done, run: (runs.runs || [])[0] };
  }

  // ---------------------------------------------------------------------------------------------------------
  console.log("\n▶ C. Grabación inválida: no se inventa nada");
  await sw.evaluate(() => startRecording("wallapop"));
  await sleep(1200);
  let r = await sw.evaluate(() => stopRecording());
  check("sin actividad → error claro «no_create»", r.ok === false && r.error.code === "no_create", JSON.stringify(r.error));
  check("no se guardó ningún perfil", (await profile("wallapop")) === null);
  check("la grabación fallida deja un diagnóstico sin secretos", r.diag?.marketplace === "wallapop" && Array.isArray(r.diag.calls) && !JSON.stringify(r.diag).includes(TOKEN), JSON.stringify(r.diag));
  await closeTabs();

  // ---------------------------------------------------------------------------------------------------------
  console.log("\n▶ A1. Wallapop (API JSON): el usuario sube y borra un anuncio de prueba con los valores indicados");
  const { sentinels: sW } = await sw.evaluate(() => startRecording("wallapop"));
  let pg = await findPage(/wallapop\.com\/app\/catalog\/upload/);
  await pg.waitForLoadState("load"); await sleep(1800);
  await pg.fill("input[name=title]", sW.title); await pg.fill("textarea[name=description]", sW.description); await pg.fill("input[name=sale_price]", sW.price);
  await pg.setInputFiles("input[type=file]", { name: "foto.jpg", mimeType: "image/jpeg", buffer: JPG });
  await pg.click("button[type=submit]");
  await pg.waitForURL(/\/item\//, { timeout: 15000 }); await sleep(900);
  await pg.click("#b"); await pg.click("#y");
  await pg.waitForURL(/mis-productos/, { timeout: 15000 }); await sleep(1200);
  r = await sw.evaluate(() => stopRecording());
  check("el perfil se dedujo solo", r.ok === true, JSON.stringify(r.error || r.report));
  let p = await profile("wallapop");
  const pubW = p?.api?.publish, create = pubW?.steps?.find((s) => s.name === "crear");
  check("estado «draft» (aún NO verificado)", p?.status === "draft" && !p?.verifiedHash);
  check("plantillas: título, descripción, precio numérico, fotos enlazadas", create?.body?.value?.title === "{{title}}" && create.body.value.description === "{{description}}" && create.body.value.sale_price.amount === "{{price}}" && create.body.value.pictures === "{{photoIds}}", JSON.stringify(create?.body));
  check("fotos soportadas con paso previo por foto", pubW?.photos === true && pubW.steps[0].repeatPerPhoto === true && pubW.steps[0].collect?.photoIds === "id");
  check("constantes del anuncio de prueba declaradas (categoría…)", pubW?.bakedFields?.some((b) => b.path === "category_leaf_id" && b.value === "100") && pubW.bakedFields.some((b) => b.path === "location.latitude" && b.value === "<oculto>"));
  check("retirada: DELETE /items/{{id}}, idempotente", p?.api?.delete?.steps?.[0]?.method === "DELETE" && p.api.delete.steps[0].url.endsWith("/api/v3/items/{{id}}") && p.api.delete.idempotent === true);
  check("sin secretos en el perfil (ni token de sesión)", !JSON.stringify(p).includes(TOKEN) && !/Bearer/.test(JSON.stringify(p)));
  check("la creación llevaba cabeceras de sesión → requireSession", pubW?.requireSession === true);
  await closeTabs();

  // ---------------------------------------------------------------------------------------------------------
  // El popup muestra el estado (humo de la interfaz)
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html`); await sleep(1200);
  const popText = await pop.locator("#apiList").textContent();
  check("popup: muestra «Perfil aprendido, sin verificar» y el botón de verificar", /sin verificar/.test(popText) && /Verificar con anuncio de prueba/.test(popText) && /category_leaf_id/.test(popText), popText.slice(0, 300));
  await pop.close();

  // ---------------------------------------------------------------------------------------------------------
  let o = await runJob("A2. Perfil sin verificar → la cola publica por DOM, pero con el tap aprendido (URL real)", "wallapop", "publish");
  check("éxito vía DOM (el modo API NO se usa sin verificar)", o.done?.p_success === true && o.run?.via === "dom", JSON.stringify(o.run));
  const firstItem = [...W.items.entries()].pop();
  check("URL guardada = URL pública real, compuesta por el tap aprendido", firstItem && o.done?.p_external_url === `https://es.wallapop.com/item/${firstItem[1].slug}`, o.done?.p_external_url);
  const urlFromDom = o.done?.p_external_url;

  // ---------------------------------------------------------------------------------------------------------
  console.log("\n▶ A3. Autoprueba: publicar y retirar POR API un anuncio de prueba");
  const itemsBefore = W.items.size, logBefore = W.log.length;
  await sw.evaluate(() => startSelftest("wallapop"));
  p = await until(async () => { const x = await profile("wallapop"); return x?.lastSelftest ? x : null; }, 60000);
  check("autoprueba superada → estado «verified» ligado al hash del plan", p?.status === "verified" && p.verifiedHash === p.hash && p.lastSelftest?.ok === true, JSON.stringify(p?.lastSelftest));
  const selfLog = W.log.slice(logBefore).filter((x) => x.path !== "/api/v3/me");
  check("el servidor vio: foto (multipart) → crear (JSON) → borrar", selfLog.map((x) => `${x.method} ${x.path.replace(/[^/]+$/, (s) => (/^k\d/.test(s) ? ":id" : s))}`).join(" | ") === "POST /api/v3/pictures | POST /api/v3/items | DELETE /api/v3/items/:id", JSON.stringify(selfLog));
  check("el anuncio de prueba se borró solo (sin residuos)", W.items.size === itemsBefore, `${W.items.size} vs ${itemsBefore}`);
  await closeTabs();

  o = await runJob("A4. Verificado pero SIN consentimiento de constantes → publica por DOM", "wallapop", "publish");
  check("éxito vía DOM (publicar por API exige aceptar las constantes copiadas)", o.done?.p_success === true && o.run?.via === "dom", JSON.stringify(o.run));

  await sw.evaluate(() => MLProfiles.update("wallapop", (x) => ({ ...x, consent: { baked: true } })));
  o = await runJob("A5. Con consentimiento → publica POR API con los datos del anuncio real", "wallapop", "publish");
  const apiItem = [...W.items.entries()].pop()[1];
  check("éxito vía API", o.done?.p_success === true && o.run?.via === "api", JSON.stringify(o.run));
  check("el servidor recibió título/precio del anuncio y la foto subida", apiItem.title === "Producto prueba" && apiItem.sale_price.amount === 12.5 && apiItem.pictures.length === 1 && apiItem.ours === true, JSON.stringify(apiItem));
  check("constantes del perfil aplicadas (categoría, ubicación)", apiItem.category_leaf_id === "100" && apiItem.location.latitude === 41.3851);
  check("URL pública compuesta con el slug del servidor", o.done?.p_external_url === `https://es.wallapop.com/item/${apiItem.slug}`, o.done?.p_external_url);
  const apiUrl = o.done?.p_external_url;

  o = await runJob("A6. Retirar POR API con el id sacado de la URL guardada", "wallapop", "delete", apiUrl);
  check("éxito vía API y el anuncio ya no existe", o.done?.p_success === true && o.run?.via === "api" && ![...W.items.values()].some((i) => `https://es.wallapop.com/item/${i.slug}` === apiUrl), JSON.stringify(o.run));
  o = await runJob("A6b. Retirar el publicado por DOM (URL con otro slug)", "wallapop", "delete", urlFromDom);
  check("éxito: también resuelve su id", o.done?.p_success === true && o.run?.via === "api", JSON.stringify(o.run));

  // ---------------------------------------------------------------------------------------------------------
  console.log("\n▶ A7. El sitio CAMBIA (ahora exige un campo nuevo): el modo API se desactiva solo");
  W.needNewField = true;
  const apiLogLen = W.log.length;
  o = await runJob("A7a. primera tarea tras el cambio", "wallapop", "publish");
  check("fallo NO definitivo (rechazo limpio 422: nada se creó, la cola reintenta)", o.done?.p_success === false && o.done?.p_fatal === false && /422/.test(o.done?.p_error || ""), JSON.stringify(o.done));
  p = await profile("wallapop");
  check("aún «verified» tras 1 fallo (puede ser un fallo puntual)", p?.status === "verified" && p.health.failures === 1, JSON.stringify(p?.health));
  o = await runJob("A7b. segunda tarea", "wallapop", "publish");
  p = await profile("wallapop");
  check("tras 2 fallos seguidos → «stale» (modo API desactivado)", p?.status === "stale" && /respondi/i.test(p.staleReason || ""), JSON.stringify({ s: p?.status, r: p?.staleReason }));
  o = await runJob("A7c. tercera tarea", "wallapop", "publish");
  check("vuelve a publicar por DOM y funciona", o.done?.p_success === true && o.run?.via === "dom", JSON.stringify(o.run));
  W.needNewField = false;

  // ---------------------------------------------------------------------------------------------------------
  console.log("\n▶ B1. Todocolección (formularios clásicos): el usuario sube y borra un lote de prueba");
  const { sentinels: sT } = await sw.evaluate(() => startRecording("todocoleccion"));
  pg = await findPage(/todocoleccion\.net\//);          // se abre la portada (marcador de config.js)...
  await pg.waitForLoadState("load"); await sleep(1500);
  await pg.goto("https://www.todocoleccion.net/vender");   // ...y el usuario navega a «vender» por su cuenta
  await pg.waitForLoadState("load"); await sleep(1800);
  await pg.fill("input[name=titulo]", sT.title); await pg.fill("textarea[name=descripcion]", sT.description); await pg.fill("input[name=precio]", sT.price);
  await pg.setInputFiles("input[name=foto]", { name: "foto.jpg", mimeType: "image/jpeg", buffer: JPG });
  await pg.click("button[type=submit]");
  await pg.waitForURL(/\/lote\/\d+/, { timeout: 15000 }); await sleep(1500);
  await pg.click("button[type=submit]");
  await pg.waitForURL(/mis-lotes/, { timeout: 15000 }); await sleep(1500);
  r = await sw.evaluate(() => stopRecording());
  check("el perfil se dedujo solo (aunque las peticiones eran navegaciones, no XHR)", r.ok === true, JSON.stringify(r.error || r.report));
  p = await profile("todocoleccion");
  const stepT = p?.api?.publish?.steps?.[0];
  check("aprendió sola la URL del formulario de «vender» (la de config.js era un marcador)", p?.uploadUrl === "https://www.todocoleccion.net/vender", p?.uploadUrl);
  check("multipart con plantillas y CSRF leído de la página", stepT?.body?.kind === "form" && stepT.body.fields.titulo === "{{title}}" && stepT.body.fields.precio === "{{priceStr}}" && stepT.body.fields.csrf_token === "{{csrf}}" && p.api.publish.domVars?.csrf?.selector === 'input[name="csrf_token"]', JSON.stringify(stepT?.body));
  check("id sacado de la URL de destino; sin cabeceras de sesión", stepT?.extract?.id?.fromUrl && p.api.publish.requireSession === false && p.api.publish.urlTemplate === "https://www.todocoleccion.net/lote/{{id}}", JSON.stringify({ e: stepT?.extract, t: p?.api?.publish?.urlTemplate }));
  check("retirada: POST urlencoded a /lote/{{id}}/eliminar con CSRF", p?.api?.delete?.steps?.[0]?.url === "https://www.todocoleccion.net/lote/{{id}}/eliminar" && p.api.delete.steps[0].body.kind === "urlencoded" && p.api.delete.steps[0].body.fields.csrf_token === "{{csrf}}", JSON.stringify(p?.api?.delete));
  check("el token CSRF grabado NO quedó en el perfil", !/csrf-[a-z0-9]{6,}/.test(JSON.stringify(p)));
  await closeTabs();

  console.log("\n▶ B2. Autoprueba en dos fases (publicar en el formulario, retirar en la página del lote)");
  const lotesBefore = T.lotes.size;
  await sw.evaluate(() => startSelftest("todocoleccion"));
  p = await until(async () => { const x = await profile("todocoleccion"); return x?.lastSelftest ? x : null; }, 60000);
  check("autoprueba superada → «verified»", p?.status === "verified" && p.lastSelftest?.ok === true, JSON.stringify(p?.lastSelftest));
  check("el lote de prueba se creó y se borró solo", T.lotes.size === lotesBefore, `${T.lotes.size} vs ${lotesBefore}`);
  await closeTabs();

  await sw.evaluate(() => MLProfiles.update("todocoleccion", (x) => ({ ...x, consent: { baked: true } })));
  o = await runJob("B3. Cola: publicar POR API (CSRF de la página + cookie + multipart con la foto)", "todocoleccion", "publish");
  const lote = [...T.lotes.entries()].pop();
  check("éxito vía API", o.done?.p_success === true && o.run?.via === "api", JSON.stringify(o.run));
  check("el sitio recibió título, precio (12.5) y categoría copiada", lote && lote[1].titulo === "Producto prueba" && lote[1].precio === "12.5" && lote[1].categoria === "monedas", JSON.stringify(lote));
  check("URL pública = /lote/<id real>", lote && o.done?.p_external_url === `https://www.todocoleccion.net/lote/${lote[0]}`, o.done?.p_external_url);

  o = await runJob("B4. Cola: retirar POR API (formulario de borrado con su CSRF)", "todocoleccion", "delete", o.done?.p_external_url);
  check("éxito vía API y el lote ya no existe", o.done?.p_success === true && o.run?.via === "api" && !T.lotes.has(lote?.[0]), JSON.stringify(o.run));

  // ---------------------------------------------------------------------------------------------------------
  // E. APRENDIZAJE AUTOMÁTICO: sin que nadie toque el sitio, la extensión sube y borra el anuncio de prueba,
  // deduce el perfil y lo verifica por API. Se parte de cero (sin perfil) en los dos marketplaces.
  const autoLast = (mk) => sw.evaluate((m) => chrome.storage.local.get("autoLast").then((x) => (x.autoLast || {})[m] || null), mk);
  const autoRun = async (mk, verify = true) => {
    await sw.evaluate((m) => MLProfiles.update(m, () => null), mk);
    const rep = await sw.evaluate(([m, v]) => startAutoLearn(m, v), [mk, verify]);
    check(`[${mk}] el aprendizaje automático arrancó`, rep.started === true, JSON.stringify(rep));
    const last = await until(() => autoLast(mk), 90000);
    let pr = await profile(mk);
    if (verify && last?.ok) pr = await until(async () => { const x = await profile(mk); return x?.lastSelftest ? x : null; }, 60000);
    await closeTabs();
    return { last, pr };
  };

  console.log("\n▶ E1. Wallapop: aprender solo + verificar, sin tocar nada");
  let itemsN = W.items.size;
  let e = await autoRun("wallapop");
  check("aprendió y borró su anuncio de prueba (sin residuos)", e.last?.ok === true && W.items.size === itemsN, JSON.stringify({ last: e.last, n: [W.items.size, itemsN] }));
  const aC = e.pr?.api?.publish?.steps?.find((x) => x.name === "crear");
  check("mismo esquema que con grabación manual (plantillas, fotos, borrado)", aC?.body?.value?.title === "{{title}}" && aC.body.value.sale_price.amount === "{{price}}" && e.pr.api.publish.photos === true && e.pr.api.delete?.steps?.[0]?.url.endsWith("/api/v3/items/{{id}}"), JSON.stringify(aC?.body));
  check("verificado por API sin intervención y ligado al hash", e.pr?.status === "verified" && e.pr.verifiedHash === e.pr.hash && e.pr.lastSelftest?.ok === true, JSON.stringify(e.pr?.lastSelftest));
  check("constantes copiadas SIN consentimiento (hay que aceptarlas a mano)", (e.pr?.api?.publish?.bakedFields || []).length > 0 && !e.pr.consent?.baked);
  check("sin secretos en el perfil", !JSON.stringify(e.pr).includes(TOKEN));
  const rec0 = await sw.evaluate(() => chrome.storage.session.get(["rec", "auto"]));
  check("la grabación quedó cerrada", !rec0.rec && !rec0.auto, JSON.stringify(rec0));
  o = await runJob("E1b. Perfil aprendido solo, sin aceptar constantes: publicar", "wallapop", "publish");
  check("sin consentimiento sigue publicando por DOM", o.done?.p_success === true && o.run?.via === "dom", JSON.stringify(o.run));

  console.log("\n▶ E2. Todocolección (formularios clásicos): encuentra «vender» sola, aprende y verifica");
  const lotesN = T.lotes.size;
  e = await autoRun("todocoleccion");
  check("aprendió y borró su lote de prueba (sin residuos)", e.last?.ok === true && T.lotes.size === lotesN, JSON.stringify({ last: e.last, n: [T.lotes.size, lotesN] }));
  const aT = e.pr?.api?.publish?.steps?.[0];
  check("siguió el enlace «Vender» y aprendió la URL real del formulario", e.pr?.uploadUrl === "https://www.todocoleccion.net/vender", e.pr?.uploadUrl);
  check("multipart con plantillas + CSRF de la página + id de la URL", aT?.body?.kind === "form" && aT.body.fields.titulo === "{{title}}" && aT.body.fields.csrf_token === "{{csrf}}" && aT.extract?.id?.fromUrl && e.pr.api.publish.urlTemplate === "https://www.todocoleccion.net/lote/{{id}}", JSON.stringify(aT));
  check("retirada: POST urlencoded con CSRF", e.pr?.api?.delete?.steps?.[0]?.url === "https://www.todocoleccion.net/lote/{{id}}/eliminar" && e.pr.api.delete.steps[0].body.kind === "urlencoded", JSON.stringify(e.pr?.api?.delete));
  check("verificado por API", e.pr?.status === "verified" && e.pr.lastSelftest?.ok === true, JSON.stringify(e.pr?.lastSelftest));
  check("el token CSRF no quedó en el perfil", !/csrf-[a-z0-9]{6,}/.test(JSON.stringify(e.pr)));
  await sw.evaluate(() => MLProfiles.update("todocoleccion", (x) => ({ ...x, consent: { baked: true } })));
  o = await runJob("E2b. Cola: publicar y retirar POR API con el perfil aprendido solo", "todocoleccion", "publish");
  const loteE = [...T.lotes.entries()].pop();
  check("publica por API", o.done?.p_success === true && o.run?.via === "api" && loteE?.[1].titulo === "Producto prueba", JSON.stringify(o.run));
  o = await runJob("E2c. retirar", "todocoleccion", "delete", o.done?.p_external_url);
  check("retira por API", o.done?.p_success === true && o.run?.via === "api" && !T.lotes.has(loteE?.[0]), JSON.stringify(o.run));

  console.log("\n▶ E3. El sitio no tiene formulario reconocible: falla claro, sin inventar nada");
  W.noForm = true;
  itemsN = W.items.size;
  e = await autoRun("wallapop", false);
  W.noForm = false;
  check("error claro y sin anuncio huérfano", e.last?.ok === false && !e.last.orphan && /formulario/i.test(e.last.error || "") && W.items.size === itemsN, JSON.stringify(e.last));
  check("no se guardó ningún perfil", e.pr === null);
  check("el fallo trae un diagnóstico de la página (campos y botones, sin valores)", Array.isArray(e.last?.diag?.inputs) && Array.isArray(e.last.diag.buttons) && e.last.diag.path.includes("/app/catalog/upload"), JSON.stringify(e.last?.diag));
  const rec1 = await sw.evaluate(() => chrome.storage.session.get(["rec", "auto"]));
  check("la grabación quedó cerrada tras el fallo", !rec1.rec && !rec1.auto, JSON.stringify(rec1));

  // ---------------------------------------------------------------------------------------------------------
  console.log("\n▶ D. Seguridad");
  const leaked = sb.seen.filter((s) => s.includes(TOKEN));
  check("el token de sesión del marketplace nunca llegó a Supabase", leaked.length === 0);
  const store = JSON.stringify(await sw.evaluate(() => Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null)])));
  check("ni storage.local ni storage.session lo contienen", !store.includes(TOKEN));

  console.log(`\nRESULTADO: ${pass} correctas, ${fail} fallidas`);
  await ctx.close(); supa.close(); mk.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR DEL HARNESS:", e); process.exit(2); });
