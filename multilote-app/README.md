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
- `0005_publish_pacing.sql`: anti-baneo. Trigger `schedule_publish_job` (al encolar un `publish`: `run_after` = último turno ocupado del mismo usuario+marketplace + 2 min + 0–40 s aleatorios; si no hay nadie delante, sale ya; si cae entre 22:30 y 08:30 de Madrid, pasa a las 08:30 siguientes + 0–40 s). `claim_sync_jobs` lo hace cumplir al reclamar (un `publish` por marketplace, separado 2 min del anterior, nunca de noche), así que vale aunque la extensión haya estado cerrada. Los `delete` no se retrasan. Parámetros fijos en la propia migración.
- `0004_todocoleccion.sql`: añade `todocoleccion` al enum `marketplace`.
- `0003_retire_listing.sql`: RPC `retire_listing` (vendido/archivado → cancela publicaciones pendientes y encola un `delete` por marketplace publicado; si una publicación termina después de retirar el artículo, su `delete` se encola solo). Retirar nunca se bloquea por plan caducado.
- `0002_sync_queue_billing.sql`: `sync_queue`, RPC `claim_sync_jobs` (SKIP LOCKED, recupera tareas colgadas >10 min) y `complete_sync_job` (éxito → `publications`; fallo → reintento con backoff 2/4 min, máx. 3 intentos → `failed`), `subscriptions` y `has_active_plan()`.

## Panel web

1. Crea un proyecto en Supabase y ejecuta las migraciones `0001` a `0005` en orden.
2. En Stripe crea dos precios (17,90 €/mes recurrente y 69 € único) y un webhook a `/api/stripe/webhook` con los eventos `checkout.session.completed`, `customer.subscription.updated` y `customer.subscription.deleted`.
3. `cp .env.example .env.local` y rellena las variables.
4. `npm install && npm run dev`

## Extensión de Chrome

1. Edita `extension/config.js` con la URL y anon key de Supabase.
2. `chrome://extensions` → modo desarrollador → "Cargar descomprimida" → carpeta `extension/`.
3. Inicia sesión en el popup. Desde el panel pulsa «Publicar»: la extensión reclama la tarea, abre el formulario del marketplace en una pestaña en segundo plano, lo rellena, publica y reporta el resultado. Hay que tener la sesión abierta en cada marketplace.

## Pendiente / a validar

- Los selectores de `extension/content.js` (incluido el botón de publicar) son una primera aproximación: hay que ajustarlos al formulario real de cada marketplace (categoría, estado, talla, etc.).
- La extensión implementa `publish` y `delete`. `update` existe en el esquema pero falla con un mensaje claro.
- Retirada (`delete`): abre la URL guardada del anuncio, pulsa el botón cuyo texto sea exactamente «Eliminar/Borrar (anuncio)» y confirma en el diálogo si lo hay. Si el anuncio ya no existe, lo da por retirado. Los patrones de texto (`DELETE_BUTTON`, `CONFIRM_BUTTON`, `GONE_TEXT` en `content.js`) hay que validarlos contra cada marketplace real. Sin URL guardada del anuncio, la tarea falla pidiendo retirarlo a mano.
- Revisar los términos de uso de cada marketplace respecto a la automatización.
- Iconos de la extensión y portal de cliente de Stripe (cancelar/cambiar plan).

## Ajustar la extensión a un marketplace (inspector)

`extension/tools/inspect-dom.js` es una herramienta de desarrollo (no va en la extensión). Pegada en F12 → Console de la página del marketplace con tu sesión iniciada, registra a la vez:

1. las peticiones POST/PUT/PATCH/DELETE que dispara la página (URL, método, nombres de cabeceras, forma de los cuerpos enviados y recibidos), y
2. un resumen del DOM (campos, botones, diálogos).

Haz la prueba a mano (subir y borrar un producto de prueba, sin recargar) y ejecuta `dump()`: copia todo al portapapeles. Se anonimiza en el propio navegador: sin tokens, cookies, Authorization (solo «Bearer <redacted>»), emails/teléfonos/ubicación; los ids se sustituyen por etiquetas `ID#n` que permiten ver qué id devuelto al crear aparece luego en la URL del borrado. `mlGet(true)` registra también los GET propios; `mlClear()` borra el registro.
