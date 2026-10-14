# MultiLote

Cross-listing para vendedores en España (Wallapop, Vinted, Milanuncios). Next.js 14 + Tailwind + Supabase, más una extensión de Chrome (MV3).

## Panel web

1. Crea un proyecto en Supabase y ejecuta `supabase/migrations/0001_init.sql` en el SQL Editor.
2. `cp .env.example .env.local` y rellena `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. `npm install && npm run dev`

Incluye: landing, login/registro, listado de artículos, alta con fotos (bucket privado `listing-photos`), y detalle con estado de publicación por marketplace. RLS garantiza que cada usuario solo ve lo suyo.

## Extensión de Chrome

1. Edita `extension/config.js` con la URL y anon key de Supabase.
2. Chrome → `chrome://extensions` → activar modo desarrollador → "Cargar descomprimida" → carpeta `extension/`.
3. Abre el popup, inicia sesión con la misma cuenta, elige un artículo y pulsa el marketplace: se abre su formulario de subida y se rellena título, descripción, precio y fotos.

## Pendiente / a validar

- Los selectores de `extension/content.js` son una primera aproximación: hay que inspeccionar el formulario real de cada marketplace (categoría, estado, talla, etc.) y ajustarlos.
- Revisar los términos de uso de cada marketplace respecto a la automatización.
- Iconos de la extensión, facturación (Stripe), y sincronización de ventas.
