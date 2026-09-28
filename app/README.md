# Velvet — citas liberales con speed dating por vídeo

Web app (Node 22 + SQLite + WebSocket + WebRTC, sin build) para parejas swingers y personas solas.

## Arranque
```bash
cd app && npm install
npm start            # http://localhost:3000
npm test             # tests de integración (API + WebSocket + juegos)
```
Sin Stripe configurado, en desarrollo el botón «Suscribirme» activa una suscripción **de prueba**.

## Qué incluye
| Función | Detalle |
|---|---|
| Cuentas | Pareja (gratis), mujer (gratis), hombre solo (**9,99 €/mes**). Registro 18+ (ambos miembros de la pareja) con aceptación de normas. |
| Descubrir | Estilo Tinder: like / pasar, match mutuo. |
| Galería | Fotos públicas y **privadas** (solo se ven tras el match); validación por firma de fichero. |
| Mensajes | Chat 1‑a‑1 en tiempo real (WebSocket). Los hombres necesitan suscripción para escribir. |
| Eventos | Cualquier usuario o el admin (marcados «Oficial») crea eventos; la dirección exacta solo la ven quienes se apuntan. |
| En directo | Quién está conectado ahora y quién está en speed dating. |
| Speed dating | Cola **parejas ↔ solos/solas**, ronda de vídeo (WebRTC) con temporizador, decisión «Seguir/Pasar». Si ambos siguen → match + el vídeo continúa. |
| Juegos (tras «seguir» mutuo) | **Oca** (tablero editable en `server/board.json`) y **Espejo** (90 s uno actúa, 90 s el otro lo repite, luego se intercambian). Ambos pueden parar cuando quieran. |
| Seguridad | Bloquear, reportar, panel admin (suspender cuentas), scrypt, cookies HttpOnly, CSP, límite de intentos. |
| Pagos | Stripe Checkout + webhook con firma verificada (`server/billing.js`). |

## Tu tablero de la oca
Sustituye `server/board.json`. Cada casilla: `{ "n": 1, "type": "normal|goto|skip|end", "text": "…", "to": 12, "again": true, "turns": 1 }`.
Ahora hay una plantilla de 40 casillas con textos de ejemplo suaves.

## Antes de publicar (importante)
- **Verificación de edad real**: hoy es una declaración + fecha de nacimiento. En producción integra verificación de identidad/edad (obligatoria en muchos países para contenido adulto).
- **Normas y moderación**: define reglas, revisión de fotos y de reportes. El vídeo entre usuarios es P2P: no se graba ni pasa por el servidor.
- **Pagos**: muchos procesadores (incl. Stripe) restringen servicios para adultos; revisa sus términos o usa uno especializado.
- **RGPD**: los datos de vida sexual son categoría especial; necesitas consentimiento explícito, política de privacidad, exportar/borrar cuenta y contratos con proveedores.
- **TURN**: configura un servidor TURN (p. ej. coturn) o el vídeo fallará en muchas redes.
- **Escalado**: la cola y las salas viven en memoria de un proceso; para varias instancias hay que moverlas a Redis.
