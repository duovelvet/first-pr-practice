import crypto from 'node:crypto';
import express from 'express';
import { db, now } from './db.js';

const KEY = process.env.STRIPE_SECRET_KEY;
const PRICE = process.env.STRIPE_PRICE_ID; // precio recurrente de 9,99 €/mes creado en Stripe
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
export const stripeEnabled = !!(KEY && PRICE);
export const DEV_BILLING = !stripeEnabled && process.env.NODE_ENV !== 'production';
export const PRICE_LABEL = '9,99 €/mes';

async function stripe(path, params) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'stripe error');
  return j;
}

/** Comprueba la firma `Stripe-Signature` (esquema v1, tolerancia 5 min). */
export function verifyStripeSignature(raw, header, secret) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function applySubscription(sub) {
  const active = ['active', 'trialing'].includes(sub.status);
  db.prepare('UPDATE users SET sub_status=?, sub_until=? WHERE stripe_customer=?').run(
    active ? 'active' : sub.status,
    active ? sub.current_period_end * 1000 : 0,
    sub.customer,
  );
}

export function webhookRouter() {
  const r = express.Router();
  r.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    if (!WEBHOOK_SECRET) return res.status(503).end();
    const raw = req.body.toString('utf8');
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], WEBHOOK_SECRET)) return res.status(400).end();
    const ev = JSON.parse(raw);
    const obj = ev.data.object;
    if (ev.type === 'checkout.session.completed' && obj.client_reference_id) {
      db.prepare('UPDATE users SET stripe_customer=? WHERE id=?').run(obj.customer, Number(obj.client_reference_id));
    } else if (ev.type.startsWith('customer.subscription.')) {
      applySubscription(obj);
    }
    res.json({ received: true });
  });
  return r;
}

export function billingRoutes(api, requireAuth) {
  api.post('/billing/checkout', requireAuth, async (req, res) => {
    const u = req.user;
    if (u.kind !== 'man') return res.status(400).json({ error: 'Solo los hombres solos necesitan suscripción' });
    if (DEV_BILLING) return res.json({ dev: true });
    if (!stripeEnabled) return res.status(503).json({ error: 'Pagos no configurados' });
    try {
      const s = await stripe('checkout/sessions', {
        mode: 'subscription',
        'line_items[0][price]': PRICE,
        'line_items[0][quantity]': '1',
        client_reference_id: String(u.id),
        ...(u.stripe_customer ? { customer: u.stripe_customer } : { customer_email: u.email }),
        success_url: `${BASE_URL}/#/premium?ok=1`,
        cancel_url: `${BASE_URL}/#/premium`,
      });
      res.json({ url: s.url });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  api.post('/billing/portal', requireAuth, async (req, res) => {
    if (!stripeEnabled || !req.user.stripe_customer) return res.status(400).json({ error: 'Sin suscripción' });
    try {
      const s = await stripe('billing_portal/sessions', { customer: req.user.stripe_customer, return_url: `${BASE_URL}/#/premium` });
      res.json({ url: s.url });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Solo para desarrollo local sin Stripe: activa 30 días.
  api.post('/billing/dev-activate', requireAuth, (req, res) => {
    if (!DEV_BILLING) return res.status(404).end();
    db.prepare("UPDATE users SET sub_status='active', sub_until=? WHERE id=?").run(now() + 30 * 864e5, req.user.id);
    res.json({ ok: true });
  });
}
