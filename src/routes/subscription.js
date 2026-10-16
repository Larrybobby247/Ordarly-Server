import { Router, raw } from 'express';
import crypto from 'crypto';
import { SubscriptionPayment, OrderPayment, WebhookEvent } from '../models/index.js';
import { verifyOrderPayment } from '../services/orderPayments.js';
import { wrap, randomToken } from '../utils/helpers.js';
import { requireAuth, loadRestaurant } from '../middleware/auth.js';
import { activateFromPayment, ensureSubscription } from '../services/subscription.js';
import { getPlanConfig } from '../services/settings.js';

const PS = 'https://api.paystack.co';
// Calls time out after 12s and a network failure becomes a normal { status:false, message } result, so a slow or unreachable
// Paystack can no longer hang the request or crash the route.
const ps = (path, opts = {}) => fetch(PS + path, {
  ...opts, signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
}).then((r) => r.json()).catch((e) => ({ status: false, message: e.name === 'TimeoutError' ? 'Paystack took too long to respond.' : 'Could not reach Paystack.' }));

// FIX: same metadata normalisation as orderPayments — Paystack may return it as a JSON string.
const parseMeta = (m) => {
  if (!m) return {};
  if (typeof m === 'string') { try { return JSON.parse(m) || {}; } catch { return {}; } }
  return m;
};

export const subscriptionRouter = Router();
subscriptionRouter.use(requireAuth, loadRestaurant);

subscriptionRouter.get('/', wrap(async (req, res) => {
  const payments = await SubscriptionPayment.find({ restaurant: req.restaurant._id }).sort('-createdAt').limit(20).lean();
  res.json({ subscription: req.subscription, isPro: req.isPro, price: req.planConfig.pro.priceNgn, payments });
}));

subscriptionRouter.post('/checkout', wrap(async (req, res) => {
  if (!process.env.PAYSTACK_SECRET_KEY) return res.status(503).json({ error: 'Subscription payments are not configured yet (PAYSTACK_SECRET_KEY missing).' });
  const cfg = await getPlanConfig();
  const sub = await ensureSubscription(req.restaurant._id);
  const reference = 'SUB-' + randomToken(10);
  const amount = cfg.pro.priceNgn; // price from server config, never from the client
  const payment = await SubscriptionPayment.create({ restaurant: req.restaurant._id, subscription: sub._id, providerReference: reference, amount });
  const data = await ps('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email: req.user.email, amount: amount * 100, reference, currency: 'NGN',
      callback_url: `${process.env.CLIENT_URL}/dashboard/subscription?ref=${reference}`,
      metadata: { purpose: 'pro_subscription', restaurantId: String(req.restaurant._id) },
    }),
  });
  if (!data.status) { payment.status = 'failed'; await payment.save(); return res.status(502).json({ error: data.message || 'Could not start payment' }); }
  res.json({ authorizationUrl: data.data.authorization_url, reference });
}));

// Customer returns from Paystack: we verify server-side. The query param alone proves nothing.
subscriptionRouter.post('/verify', wrap(async (req, res) => {
  // FIX: the callback URL this server generates carries the reference in the QUERY (?ref=SUB-...).
  // Accept it from the body OR the query so a frontend that posts it back either way still resolves.
  const reference = req.body?.reference || req.query?.ref;
  if (!reference) return res.status(400).json({ error: 'Missing payment reference' });
  const payment = await SubscriptionPayment.findOne({ providerReference: String(reference), restaurant: req.restaurant._id });
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  try { res.json(await verifySubscriptionPayment(payment)); }
  catch (e) { console.error('[subscription verify]', e); res.status(500).json({ error: 'Payment was found but we could not finish activating Pro. Please try "Check status" again in a moment.' }); }
}));

export async function verifySubscriptionPayment(payment) {
  if (payment.status === 'success') return { status: 'success' };
  const data = await ps(`/transaction/verify/${encodeURIComponent(payment.providerReference)}`);
  if (!data.status) {
    console.error('[subscription verify] Paystack lookup failed (left pending for retry)', {
      reference: payment.providerReference, message: data.message,
    });
    return { status: 'pending', message: `Paystack verification error: ${data.message || 'Unknown error'}` };
  }
  const t = data.data;

  if (t.status === 'success') {
    const expectedKobo = Math.round(Number(payment.amount) * 100);
    const meta = parseMeta(t.metadata); // FIX: normalise metadata before reading it
    const belongsHere = !meta.restaurantId || String(meta.restaurantId) === String(payment.restaurant);
    // FIX: numeric comparison on both sides; currency case-insensitive
    const paidKobo = Math.round(Number(t.amount));
    const amountOk = Number.isFinite(paidKobo) && paidKobo === expectedKobo;
    const currencyOk = String(t.currency || '').toUpperCase() === 'NGN';

    if (amountOk && currencyOk && belongsHere) {
      await activateFromPayment(payment);
      // FIX: re-read — activation may have been completed by a concurrent webhook; report the truth.
      const fresh = await SubscriptionPayment.findById(payment._id).lean();
      return { status: fresh?.status === 'success' ? 'success' : 'pending' };
    }
    // Amount/currency mismatch is a real fraud signal — do NOT activate Pro.
    if (!amountOk || !currencyOk) {
      console.error('[subscription verify] PAID BUT MISMATCHED — marking failed (Pro NOT activated)', {
        reference: payment.providerReference, expectedKobo, actualKobo: t.amount, currency: t.currency,
      });
      await SubscriptionPayment.updateOne({ _id: payment._id, status: { $ne: 'success' } }, { status: 'failed' });
      return { status: 'failed', reason: 'mismatch', message: 'Paystack reports this payment as successful, but it does not match our records, so it was not applied. Contact support with your reference.' };
    }
    // FIX: metadata-only mismatch — money IS received and matches on amount/currency. Don't fail it;
    // leave pending so the webhook/reconcile/support can apply it instead of stranding a paying customer.
    console.error('[subscription verify] metadata mismatch — left pending for review (payment PAID)', {
      reference: payment.providerReference, metaRestaurantId: meta.restaurantId, restaurant: String(payment.restaurant),
    });
    return { status: 'pending', message: 'Payment received; it is being reviewed before Pro is activated.' };
  }
  if (['failed', 'abandoned', 'reversed'].includes(t.status)) {
    await SubscriptionPayment.updateOne({ _id: payment._id, status: 'pending' }, { status: 'failed' });
    return { status: 'failed' };
  }
  return { status: 'pending' };
}

/** Paystack webhook. Mounted with express.raw BEFORE express.json. */
export const webhookRouter = Router();
webhookRouter.post('/paystack', raw({ type: '*/*' }), wrap(async (req, res) => {
  const sig = req.headers['x-paystack-signature'];
  const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY || '').update(req.body).digest('hex');
  if (!sig || sig.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hash))) return res.sendStatus(401);
  res.sendStatus(200); // ack fast; process after

  const event = JSON.parse(req.body.toString());
  const ref = event.data?.reference;
  const eventId = `${event.event}:${event.data?.id || ref}`;
  try { await WebhookEvent.create({ provider: 'paystack', eventId, type: event.event }); }
  catch { return; } // duplicate delivery: already handled

  if (event.event === 'charge.success' && ref?.startsWith('SUB-')) {
    const payment = await SubscriptionPayment.findOne({ providerReference: ref });
    if (payment) await verifySubscriptionPayment(payment); // re-verify with Paystack; never trust body alone
  }
  // Food-order payments live in a separate module/collection (never mixed with subscriptions).
  if (event.event === 'charge.success' && ref?.startsWith('FOD-')) {
    const op = await OrderPayment.findOne({ providerReference: ref });
    if (op) await verifyOrderPayment(op);
  }
}));
