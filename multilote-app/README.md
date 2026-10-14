# MultiLote

Cross-listing para vendedores en España (Wallapop, Vinted, Milanuncios y Todocolección). Next.js 14 + Tailwind + Supabase, más una extensión de Chrome (MV3).

## Modelo de negocio

- **Mensual:** 17,90 €/mes. **Fundador:** 69 € de pago único (sin caducidad).
- Prueba gratuita de 7 días desde el registro (constante `TRIAL_DAYS` en `src/lib/plans.ts` y en `has_active_plan()` de la migración 0002; deben coincidir).
- Encolar publicaciones exige plan activo o prueba, y se aplica en la base de datos (RLS de `sync_queue`), no solo en la interfaz.

## Arquitectura

```
Panel web ── INSERT ──▶ sync_queue ◀── claim_sync_jobs() ── Extensión (alarma cada 1 min)
     ▲                      │                                     │ abre pestaña, content.js rellena y publica
     └──── publications ◀── complete_sync_job(ok | error + backoff) ◀┘
```

- `0001_init.sql`: listings, publications, bucket privado de fotos.
- `0006_fatal_failures.sql`: `complete_sync_job` gana `p_fatal` (por defecto `false`, las llamadas antiguas siguen valiendo): fallo definitivo, sin reintentos, para resultados ambiguos tras enviar una petición que crea algo (evita anuncios duplicados). La publicación queda en `error` para revisión humana.
- `0005_publish_pacing.sql`: anti-baneo. Trigger `schedule_publish_job` (al encolar un `publish`: `run_after` = último turno ocupado del mismo usuario+marketplace + 2 min + 0–40 s aleatorios; si no hay nadie delante, sale ya; si cae entre 22:30 y 08:30 de Madrid, pasa a las 08:30 siguientes + 0–40 s). `claim_sync_jobs` lo hace cumplir al reclamar (un `publish` por marketplace, separado 2 min del anterior, nunca de noche), así que vale aunque la extensión haya estado cerrada. Los `delete` no se retrasan. Parámetros fijos en la propia migración.
- `0004_todocoleccion.sql`: añade `todocoleccion` al enum `marketplace`.
- `0003_retire_listing.sql`: RPC `retire_listing` (vendido/archivado → cancela publicaciones pendientes y encola un `delete` por marketplace publicado; si una publicación termina después de retirar el artículo, su `delete` se encola solo). Retirar nunca se bloquea por plan caducado.
- `0002_sync_queue_billing.sql`: `sync_queue`, RPC `claim_sync_jobs` (SKIP LOCKED, recupera tareas colgadas >10 min) y `complete_sync_job` (éxito → `publications`; fallo → reintento con backoff 2/4 min, máx. 3 intentos → `failed`), `subscriptions` y `has_active_plan()`.

## Panel web

1. Crea un proyecto en Supabase y ejecuta las migraciones `0001` a `0006` en orden.
2. En Stripe crea dos precios (17,90 €/mes recurrente y 69 € único) y un webhook a `/api/stripe/webhook` con los eventos `checkout.session.completed`, `customer.subscription.updated` y `customer.subscription.deleted`.
3. `cp .env.example .env.local` y rellena las variables.
4. `npm install && npm run dev`

## Extensión de Chrome (Manifest V3)

1. Edita `extension/config.js` con la URL y anon key de Supabase.
2. `chrome://extensions` → modo desarrollador → «Cargar descomprimida» → carpeta `extension/` (Chrome ≥ 111).
3. Inicia sesión en el popup. Desde el panel pulsa «Publicar»: la extensión reclama la tarea, abre la página del marketplace en una pestaña en segundo plano, la ejecuta y reporta el resultado. Hay que tener la sesión abierta en cada marketplace. El popup muestra los últimos resultados; una insignia roja `!` indica que falta iniciar sesión en un marketplace.

### Cómo está organizada

```
background.js          service worker: alarma 1 min -> claim_sync_jobs -> abre pestaña -> complete_sync_job
page-hook.js           MUNDO PRINCIPAL de la página (world "MAIN", document_start): observa fetch/XHR de la web,
                       "taps" declarativos (extrae id/URL reales) y ejecuta llamadas a la API con la sesión viva
lib/bridge.js          content script (mundo aislado): puente postMessage hacia page-hook.js
lib/dom.js             utilidades de DOM (rellenar campos, esperar, localizar botones por texto exacto)
lib/api-plan.js        ejecutor de planes de API DECLARATIVOS (pasos HTTP con plantillas {{var}})
lib/plan-synth.js      deduce un perfil (planes publicar/retirar) a partir de una grabación con valores centinela
lib/profiles.js        perfiles aprendidos: almacén, verificación por hash, consentimiento y salud (stale)
lib/recorder.js        modo aprendizaje: retransmite las peticiones del gancho y los envíos de formularios nativos
adapters/<sitio>.js    TODO lo que depende de cada marketplace, como datos: selectores, textos de retirada,
                       tap de confirmación, plan de API (publish/delete) y bandera api.verified
content.js             motor: elige estrategia, ejecuta, informa; marca fallos definitivos
```

Estrategia por tarea: **API** (solo si el adaptador tiene `api.verified = true` y hay sesión detectada en la página) → **DOM** de respaldo. Si la API responde 401/403 (o no hay sesión) se cae al DOM; con 429 o un rechazo limpio (400/404/422) se reintenta por la cola; y si **ya se envió una petición que crea algo y el resultado es ambiguo** (5xx, corte de red, no se pudo confirmar el clic en «publicar», pestaña cerrada a mitad) el fallo es **definitivo**: ni se prueba otra vía ni se reintenta, para no duplicar el anuncio. Retirar es idempotente: 404 = ya retirado y reintentar siempre es seguro.

### Modelo de seguridad de la sesión

- Los tokens/cabeceras de sesión del marketplace se guardan **solo en memoria de `page-hook.js`**, dentro de la página. No se envían al content script, ni al service worker, ni a Supabase, ni se guardan en `chrome.storage` (lo verifica la suite E2E).
- El canal `window.postMessage` entre el gancho y el content script **no es de confianza** (los scripts de la web también lo ven): solo viajan datos no sensibles (ids extraídos, estados HTTP).
- El gancho solo hace peticiones `https` a la misma familia de dominios que la página.

### Modo API: aprender y verificar (sin consola)

Está **desactivado** en todos los adaptadores del repositorio (`api.verified = false`): los endpoints reales no se conocen y no se adivinan. En su lugar, cada instalación los **aprende** y los **verifica** ella sola:

1. Popup → **Modo API (avanzado)** → marketplace → **Aprender**. Se abre el sitio; hazlo todo a mano con los valores que muestra el popup (título `MLTEST-1234`, precio `7.77`…): sube **una foto**, publica, abre el anuncio y **elimínalo**.
2. **Terminar y analizar**: `lib/plan-synth.js` localiza dónde viajó cada valor centinela y deduce el perfil: plantillas `{{title}}`/`{{price}}`…, cómo extraer el id de la respuesta o de la URL tras redirecciones, el token CSRF de la página, la petición de borrado, la URL del formulario de subida y cómo sacar el id de la URL guardada del anuncio. Funciona con APIs JSON (`fetch`/XHR) y con formularios clásicos (navegaciones).
3. El perfil queda en **borrador**. Lo que no era un valor centinela se copia tal cual del anuncio de prueba (categoría, ubicación, envío…): el popup lo lista y, **si quieres publicar por API, hay que marcarlo expresamente**; si no, publicar sigue por la página. Retirar no tiene ese problema.
4. **Verificar con anuncio de prueba**: la extensión publica y retira un anuncio de prueba **por API**. Solo si va bien el perfil pasa a **verificado** (ligado al hash del plan). Si algo falla, el popup lo dice y avisa si quedó un anuncio de prueba por borrar.
5. **Salud**: si el sitio responde distinto a lo aprendido dos veces seguidas (p. ej. 422 por un campo nuevo), el perfil pasa a **desactivado** y todo vuelve a la página sin intervención.

Límites: las fotos solo se suben por API si el sitio las acepta como petición multipart a su propio dominio (si van a un CDN externo, esos anuncios van por la página); si el sitio firma cada petición con JavaScript propio, la API no es replicable y se queda en DOM. El perfil vive en `chrome.storage.local` (sin tokens ni cookies).

### Pruebas

- `npm run test:unit`: sintetizador de perfiles (función pura) con grabaciones de ejemplo, incluidos los casos de error.
- `npm run test:e2e:learn`: el aprendizaje completo con la extensión real y dos sitios simulados (API JSON con validación y formularios con CSRF de un solo uso): grabar → deducir → verificar → publicar/retirar desde la cola → degradar si el sitio cambia, y que ningún token salga de la página ni se guarde en el perfil.
- `npm run test:e2e` carga la extensión **real** en Chromium con un Supabase simulado y un marketplace simulado (HTTPS local, cabeceras de sesión, CORS, diálogo de confirmación) y ejercita 10 escenarios: publicar/retirar por API, caída al DOM ante 401, fallo definitivo ante 500, 404 como «ya retirado», sin sesión, rechazo de la web, publicación sin confirmar, y que ningún token salga de la página. Los planes de API de esas pruebas son de ejemplo, no los de Wallapop.

## Pendiente / a validar

- Los selectores y planes de `extension/adapters/*.js` son una primera aproximación sin verificar contra los sitios reales: hay que ajustarlos con tráfico y DOM capturados (categoría, estado, talla, etc.).
- Límite conocido: si el navegador se cierra con una publicación a medias, el servidor recupera la tarea a los 10 min y la reintenta; el aviso de «ya envié la petición» vive en memoria de sesión del worker y no sobrevive a un reinicio del navegador.
- La extensión implementa `publish` y `delete`. `update` existe en el esquema pero falla con un mensaje claro.
- Retirada (`delete`): abre la URL guardada del anuncio, pulsa el botón cuyo texto sea exactamente «Eliminar/Borrar (anuncio)» y confirma en el diálogo si lo hay. Si el anuncio ya no existe, lo da por retirado. Los patrones de texto (`deleteButton`, `confirmButton`, `goneText` en `lib/dom.js` / cada adaptador) hay que validarlos contra cada marketplace real. Sin URL guardada del anuncio, la tarea falla pidiendo retirarlo a mano.
- Revisar los términos de uso de cada marketplace respecto a la automatización.
- Iconos de la extensión y portal de cliente de Stripe (cancelar/cambiar plan).

## Ajustar la extensión a un marketplace (inspector)

`extension/tools/inspect-dom.js` es una herramienta de desarrollo (no va en la extensión). Pegada en F12 → Console de la página del marketplace con tu sesión iniciada, registra a la vez:

1. las peticiones POST/PUT/PATCH/DELETE que dispara la página (URL, método, nombres de cabeceras, forma de los cuerpos enviados y recibidos), y
2. un resumen del DOM (campos, botones, diálogos).

Haz la prueba a mano (subir y borrar un producto de prueba, sin recargar) y ejecuta `dump()`: copia todo al portapapeles. Se anonimiza en el propio navegador: sin tokens, cookies, Authorization (solo «Bearer <redacted>»), emails/teléfonos/ubicación; los ids se sustituyen por etiquetas `ID#n` que permiten ver qué id devuelto al crear aparece luego en la URL del borrado. `mlGet(true)` registra también los GET propios; `mlClear()` borra el registro.

### Bundle de una sola línea (para pegar sin errores)

`npm run build:inspector` genera `extension/tools/dist/inspect-dom.min.js`: una sola línea, sin comentarios y solo ASCII (los acentos y símbolos van como `\uXXXX`), así no se rompe al copiar y pegar desde un chat ni en la consola de Chrome. Es el archivo recomendado para pegar. Hay que regenerarlo cada vez que cambie `inspect-dom.js`.

Forma más cómoda de usarlo: F12 → pestaña **Sources** → **Snippets** → *New snippet* → pegar el contenido → Ctrl+Enter. El snippet queda guardado y no requiere `allow pasting`.
