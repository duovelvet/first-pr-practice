#!/usr/bin/env node
// Aprende y verifica Wallapop / Todocolección CONTRA LOS SITIOS REALES, de punta a punta, en TU máquina.
//
//   npm run learn:real -- --yes                       (ambos marketplaces)
//   npm run learn:real -- --yes --markets wallapop    (solo uno)
//   npm run learn:real -- --yes --profile ~/ml-chrome (carpeta del perfil persistente)
//
// Qué hace: abre Chromium (con ventana) con la extensión cargada y un PERFIL PERSISTENTE; la primera vez inicias
// sesión tú en cada marketplace (se queda guardada en esa carpeta; las contraseñas nunca pasan por este script);
// después dispara «Aprender solo y verificar» (background.js `startAutoLearn`) y espera el resultado.
// El perfil aprendido queda en chrome.storage de ESA instalación: es ahí donde `verified` se gana. Después, carga la
// extensión en ese mismo perfil (o úsalo como tu navegador de trabajo) para que la cola use la API.
//
// Importante: crea y borra anuncios REALES de prueba (MLTEST-…) en tu cuenta. Por eso exige --yes.
// Requiere Playwright con Chromium (npx playwright install chromium). Chrome de marca ≥137 ignora --load-extension.
// Escribe un informe SIN secretos en learn-real-report.json.
const fs = require("fs"), path = require("path"), os = require("os"), readline = require("readline");

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : true); };
const MARKETS = String(arg("markets", "wallapop,todocoleccion")).split(",").map((s) => s.trim()).filter(Boolean);
const PROFILE = path.resolve(String(arg("profile", path.join(os.homedir(), ".multilote-chrome"))).replace(/^~/, os.homedir()));
const EXT = path.resolve(__dirname, "../extension");
const REPORT = path.resolve(String(arg("report", "learn-real-report.json")));
const TIMEOUT_MIN = Number(arg("timeout", 6));

if (arg("help")) {
  console.log("Uso: node tools/learn-real.js --yes [--markets wallapop,todocoleccion] [--profile DIR] [--timeout MIN] [--report FICHERO]");
  process.exit(0);
}
if (!arg("yes")) {
  console.error("Esto crea y borra anuncios REALES de prueba en tu cuenta. Repite con --yes para confirmarlo.");
  process.exit(2);
}
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright"));
} catch {
  console.error("Falta Playwright: npm i -D playwright && npx playwright install chromium");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, step = 1000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const ask = (q) => new Promise((res) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); res(a); }); });

// Resumen del perfil sin nada sensible (el perfil real tampoco guarda tokens, pero el informe es aún más pequeño).
const summarize = (p) => p && {
  status: p.status, verified: p.status === "verified" && p.verifiedHash === p.hash, uploadUrl: p.uploadUrl || null,
  publishSteps: (p.api?.publish?.steps || []).map((s) => `${s.method} ${s.url}`),
  deleteSteps: (p.api?.delete?.steps || []).map((s) => `${s.method} ${s.url}`),
  photos: !!p.api?.publish?.photos, bakedFields: (p.api?.publish?.bakedFields || []).map((b) => b.path),
  warnings: p.warnings || [], selftest: p.lastSelftest ? { ok: p.lastSelftest.ok, error: p.lastSelftest.error || null, orphan: !!p.lastSelftest.orphan, url: p.lastSelftest.url || null } : null,
};

(async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 20000 }));
  const report = { at: new Date().toISOString(), profileDir: PROFILE, results: {} };
  let exit = 0;

  try {
    // 1) Sesión: el usuario inicia sesión una vez en cada marketplace (queda guardada en el perfil).
    for (const mk of MARKETS) {
      const url = await sw.evaluate((m) => (typeof uploadUrlFor === "function" ? uploadUrlFor(m) : null), mk);
      if (!url) { console.error(`Marketplace desconocido: ${mk}`); exit = 2; continue; }
      const page = await ctx.newPage();
      await page.goto(url).catch(() => {});
      console.log(`\n[${mk}] Abierto ${url}. Inicia sesión en esa pestaña si hace falta.`);
    }
    if (exit) throw new Error("Marketplaces no válidos");
    await ask("\nCuando las sesiones estén iniciadas, pulsa Enter para empezar (cerraré esas pestañas)… ");
    for (const p of ctx.pages()) if (/^https?:/.test(p.url())) await p.close().catch(() => {});

    // 2) Aprender + verificar, de uno en uno (cada uno publica y borra anuncios reales).
    for (const mk of MARKETS) {
      console.log(`\n▶ ${mk}: aprendiendo solo y verificando…`);
      await sw.evaluate((m) => MLProfiles.update(m, (p) => (p && p.status === "verified" ? p : null)), mk).catch(() => {});
      const st = await sw.evaluate(([m]) => startAutoLearn(m, true), [mk]).catch((e) => ({ error: String(e.message || e) }));
      if (st.error) { report.results[mk] = { ok: false, error: st.error }; exit = 1; console.log(`   ✖ ${st.error}`); continue; }

      const last = await until(() => sw.evaluate((m) => chrome.storage.local.get("autoLast").then((x) => (x.autoLast || {})[m] || null), mk), TIMEOUT_MIN * 60000);
      let prof = await sw.evaluate((m) => MLProfiles.load(m), mk);
      if (last?.ok) prof = (await until(async () => { const x = await sw.evaluate((m) => MLProfiles.load(m), mk); return x?.lastSelftest ? x : null; }, TIMEOUT_MIN * 60000)) || prof;
      const sum = summarize(prof);
      const ok = !!(last?.ok && sum?.verified);
      report.results[mk] = { ok, autoLearn: last || { ok: false, error: "tiempo agotado" }, profile: sum };
      if (!ok) exit = 1;
      console.log(ok ? "   ✔ verificado por API" : `   ✖ ${last?.error || sum?.selftest?.error || "no se pudo verificar"}`);
      if (last?.orphan || sum?.selftest?.orphan) console.log(`   ⚠ REVISA si quedó un anuncio de prueba${last?.url || sum?.selftest?.url ? ": " + (last?.url || sum.selftest.url) : ""}`);
      for (const w of [...(last?.warnings || []), ...(sum?.warnings || [])]) console.log(`   ⚠ ${w}`);
      if (sum?.bakedFields?.length) console.log(`   ℹ constantes copiadas del anuncio de prueba (acéptalas en el popup para publicar por API): ${sum.bakedFields.join(", ")}`);
    }
  } finally {
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    console.log(`\nInforme: ${REPORT}\nPerfil de Chromium (con los perfiles aprendidos y las sesiones): ${PROFILE}`);
    await ctx.close().catch(() => {});
  }
  process.exit(exit);
})().catch((e) => { console.error("ERROR:", e.message || e); process.exit(2); });
