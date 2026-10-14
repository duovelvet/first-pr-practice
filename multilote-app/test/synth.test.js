// Pruebas unitarias del sintetizador de perfiles (función pura). Uso: node test/synth.test.js
const assert = require("assert");
const MLSynth = require("../extension/lib/plan-synth.js");

let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log("  ✔", name); } catch (e) { console.log("  ✖", name, "\n     ", e.message); process.exitCode = 1; } };
const S = { marker: "MLTEST-4821", title: "MLTEST-4821", description: "MLTEST-4821 descripcion de prueba", price: "7.77" };

// ---- Grabación tipo Wallapop: API JSON, foto subida aparte, SPA ---------------------------------------------
const wallapop = {
  marketplace: "wallapop",
  sentinels: S,
  urls: [{ t: 1000, url: "https://es.wallapop.com/app/catalog/upload" }, { t: 5000, url: "https://es.wallapop.com/item/mltest-4821-abc123def456" }, { t: 9000, url: "https://es.wallapop.com/mis-productos" }],
  calls: [
    { kind: "xhr", t: 2000, method: "POST", url: "https://api.wallapop.com/api/v3/pictures", hasSession: true,
      req: { type: "multipart", fields: { type: "item" }, files: [{ field: "file", type: "image/jpeg", size: 123 }] },
      res: { status: 200, json: { id: "pic-9f8e7d6c5b", url: "https://cdn/x.jpg" } } },
    { kind: "xhr", t: 4000, method: "POST", url: "https://api.wallapop.com/api/v3/items", hasSession: true,
      req: { type: "json", json: { title: S.title, description: S.description, sale_price: { amount: 7.77, currency: "EUR" }, category_leaf_id: "100", pictures: ["pic-9f8e7d6c5b"], location: { latitude: 41.38, longitude: 2.17 }, negotiable: false } },
      res: { status: 201, json: { id: "abc123def456", web_slug: "mltest-4821-abc123def456" } } },
    { kind: "xhr", t: 8000, method: "DELETE", url: "https://api.wallapop.com/api/v3/items/abc123def456", hasSession: true, req: { type: "none" }, res: { status: 204 } },
  ],
};

console.log("Wallapop (API JSON)");
const w = MLSynth.synthesize(wallapop);
t("sintetiza", () => assert.ok(w.ok, JSON.stringify(w.error || w.report)));
const wp = w.profile;
const create = wp.api.publish.steps.find((s) => s.name === "crear");
t("título/descr/precio → plantillas, precio numérico", () => {
  assert.strictEqual(create.body.value.title, "{{title}}");
  assert.strictEqual(create.body.value.description, "{{description}}");
  assert.strictEqual(create.body.value.sale_price.amount, "{{price}}");
});
t("fotos: paso por foto + ids enlazados al cuerpo", () => {
  const foto = wp.api.publish.steps[0];
  assert.strictEqual(foto.name, "foto"); assert.ok(foto.repeatPerPhoto && foto.harmless);
  assert.deepStrictEqual(foto.collect, { photoIds: "id" });
  assert.strictEqual(create.body.value.pictures, "{{photoIds}}");
  assert.strictEqual(wp.api.publish.photos, true);
});
t("constantes del anuncio de prueba declaradas (categoría, ubicación oculta)", () => {
  const names = wp.api.publish.bakedFields.map((b) => b.path);
  assert.ok(names.includes("category_leaf_id") && names.includes("location.latitude") && names.includes("sale_price.currency"));
  assert.strictEqual(wp.api.publish.bakedFields.find((b) => b.path === "location.latitude").value, "<oculto>");
  assert.strictEqual(wp.api.publish.bakedFields.find((b) => b.path === "category_leaf_id").value, "100");
});
t("extrae id y slug; URL pública con {{slug}}", () => {
  assert.deepStrictEqual(create.extract, { id: "id", slug: "web_slug" });
  assert.strictEqual(wp.api.publish.urlTemplate, "https://es.wallapop.com/item/{{slug}}");
  assert.deepStrictEqual(create.requireExtract, ["id"]);
});
t("retirada: DELETE con {{id}}, idempotente, 404 aceptado", () => {
  const d = wp.api.delete;
  assert.strictEqual(d.steps[0].method, "DELETE");
  assert.strictEqual(d.steps[0].url, "https://api.wallapop.com/api/v3/items/{{id}}");
  assert.ok(d.idempotent && d.steps[0].expect.includes(404));
});
t("idFromUrl saca el id de la URL guardada (con slug delante)", () => {
  const m = new RegExp(wp.idFromUrl.regex).exec(new URL("https://es.wallapop.com/item/otro-titulo-distinto-zzz999xxx888").pathname);
  assert.strictEqual(m[1], "zzz999xxx888");
});
t("tap de confirmación para el modo DOM", () => {
  assert.strictEqual(wp.confirm.method, "POST");
  assert.ok(new RegExp(wp.confirm.path.source).test("/api/v3/items") && !new RegExp(wp.confirm.path.source).test("/api/v3/items/abc"));
});
t("aprende la página del formulario de subida", () => assert.strictEqual(wp.uploadUrl, "https://es.wallapop.com/app/catalog/upload"));
t("requiere sesión (las llamadas llevaban cabecera de sesión)", () => assert.strictEqual(wp.api.publish.requireSession, true));
t("el perfil es JSON puro (serializable)", () => assert.deepStrictEqual(JSON.parse(JSON.stringify(wp)), wp));

// ---- Grabación tipo Todocolección: formularios clásicos, CSRF, redirecciones ---------------------------------
const todo = {
  marketplace: "todocoleccion",
  sentinels: S,
  urls: [{ t: 1000, url: "https://www.todocoleccion.net/vender" }, { t: 5000, url: "https://www.todocoleccion.net/lote/987654321" }, { t: 9000, url: "https://www.todocoleccion.net/mis-lotes" }],
  calls: [
    { kind: "nav", t: 4000, method: "POST", url: "https://www.todocoleccion.net/vender", hasSession: false,
      req: { type: "multipart", fields: { csrf_token: "tok-AAA111", titulo: S.title, descripcion: S.description, precio: "7.77", categoria: "monedas" }, hidden: ["csrf_token"], files: [{ field: "foto", type: "image/jpeg", size: 99 }] } },
    { kind: "nav", t: 8000, method: "POST", url: "https://www.todocoleccion.net/lote/987654321/eliminar", hasSession: false,
      req: { type: "urlencoded", fields: { csrf_token: "tok-BBB222", motivo: "vendido" }, hidden: ["csrf_token"] } },
  ],
};
console.log("Todocolección (formularios clásicos)");
const tc = MLSynth.synthesize(todo);
t("sintetiza", () => assert.ok(tc.ok, JSON.stringify(tc.error || tc.report)));
const tp = tc.profile;
t("multipart: campos con plantilla, CSRF desde el DOM, fichero como {field}", () => {
  const s = tp.api.publish.steps[0];
  assert.strictEqual(s.body.kind, "form");
  assert.strictEqual(s.body.fields.titulo, "{{title}}"); assert.strictEqual(s.body.fields.precio, "{{priceStr}}");
  assert.strictEqual(s.body.fields.csrf_token, "{{csrf}}");
  assert.deepStrictEqual(tp.api.publish.domVars.csrf, { selector: 'input[name="csrf_token"]', attr: "value" });
  assert.deepStrictEqual(s.body.files, { field: "foto" });
  assert.strictEqual(tp.api.publish.photos, true);
  assert.ok(tp.api.publish.bakedFields.some((b) => b.path === "categoria" && b.value === "monedas"));
});
t("id desde la URL de destino tras el POST; sin sesión por cabeceras", () => {
  assert.deepStrictEqual(tp.api.publish.steps[0].extract.id.fromUrl.group, 1);
  assert.strictEqual(new RegExp(tp.api.publish.steps[0].extract.id.fromUrl.regex).exec("/lote/111222333")[1], "111222333");
  assert.strictEqual(tp.api.publish.requireSession, false);
  assert.strictEqual(tp.api.publish.urlTemplate, "https://www.todocoleccion.net/lote/{{id}}");
});
t("retirada por formulario: POST urlencoded con {{id}} y CSRF", () => {
  const d = tp.api.delete.steps[0];
  assert.strictEqual(d.url, "https://www.todocoleccion.net/lote/{{id}}/eliminar");
  assert.strictEqual(d.body.kind, "urlencoded"); assert.strictEqual(d.body.fields.csrf_token, "{{csrf}}");
  assert.ok(tp.api.delete.domVars.csrf);
});
t("aprende la URL del formulario de «vender» sin que nadie se la diga", () => assert.strictEqual(tp.uploadUrl, "https://www.todocoleccion.net/vender"));
t("sin confirm por tap (la creación fue una navegación, no XHR)", () => assert.strictEqual(tp.confirm, null));

// ---- Casos de error y de honestidad ---------------------------------------------------------------------------
console.log("Errores");
t("sin título centinela → error claro, no inventa nada", () => {
  const r = MLSynth.synthesize({ ...wallapop, calls: wallapop.calls.map((c) => ({ ...c, req: { type: "json", json: { title: "otra cosa" } } })) });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, "no_create");
});
t("sin borrado grabado → perfil con publicar pero SIN plan de retirada", () => {
  const r = MLSynth.synthesize({ ...wallapop, calls: wallapop.calls.slice(0, 2) });
  assert.ok(r.ok && r.profile.api.delete === null && r.report.warnings.some((x) => /identificador|borrado/i.test(x)));
});
t("sin foto → photos=false (los anuncios con fotos irán por DOM)", () => {
  const r = MLSynth.synthesize({ ...wallapop, calls: wallapop.calls.filter((c) => !/pictures/.test(c.url)).map((c) => (c.method === "POST" ? { ...c, req: { ...c.req, json: { ...c.req.json, pictures: [] } } } : c)) });
  assert.ok(r.ok && r.profile.api.publish.photos === false);
});
t("no mezcla un POST de analítica con la creación", () => {
  const noise = { kind: "xhr", t: 3000, method: "POST", url: "https://api.wallapop.com/api/v3/events", hasSession: true, req: { type: "json", json: { ev: "click" } }, res: { status: 200 } };
  const r = MLSynth.synthesize({ ...wallapop, calls: [noise, ...wallapop.calls] });
  assert.ok(r.ok && r.report.created.url.endsWith("/api/v3/items"));
});
console.log(`\n${n} pruebas correctas${process.exitCode ? " (HAY FALLOS)" : ""}`);
