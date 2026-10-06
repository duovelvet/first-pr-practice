import http from 'node:http';
import express from 'express';
import { buildApi } from './routes.js';
import { webhookRouter } from './billing.js';
import { attachRealtime } from './realtime.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    );
    next();
  });
  app.use(webhookRouter()); // necesita el cuerpo en bruto, va antes del parser JSON
  app.use('/api', buildApi());
  app.use(express.static(new URL('../public', import.meta.url).pathname));
  const server = http.createServer(app);
  attachRealtime(server);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => console.log(`Velvet escuchando en http://localhost:${port}`));
}
