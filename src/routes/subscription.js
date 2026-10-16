import { Router, raw } from 'express';
import crypto from 'crypto';
import { SubscriptionPayment, OrderPayment, WebhookEvent } from '../models/index.js';
import { verifyOrderPayment } from '../services/orderPayments.js';
import { wrap, randomToken } from '../utils/helpers.js';
import { requireAuth, loadRestaurant } from '../middleware/auth.js';
import { activateFromPayment, ensureSubscription } from '../services/subscription.js';
import { getPlanConfig } from '../services/settings.js';

const PS = 'https://api.paystack.co';
// Changed: calls now time out after 12s and a network failure becomes a normal { status:false, message } result, so a slow or unreachable
// Paystack can no longer hang the request or crash the route.
const ps = (path, opts = {}) => fetch(PS + path, {
  ...opts, signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
}).then((r) => r.json()).catch((e) => ({ status: false, message: e.name === 'TimeoutError' ? 'Paystack took too long to respond.' : 'Could not reach Paystack.' }));

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
  const payment = await SubscriptionPayment.findOne({ providerReference: String(req.body.reference), restaurant: req.restaurant._id });
  if (!payment) return res.status(404).json({ error: 'Payment not found' });
  try { res.json(await verifySubscriptionPayment(payment)); }
  catch (e) { console.error('[subscription verify]', e); res.status(500).json({ error: 'Payment was found but we could not finish activating Pro. Please try "Check status" again in a moment.' }); }
}));

export async function verifySubscriptionPayment(payment) {
  if (payment.status === 'success') return { status: 'success' };
  const data = await ps(`/transaction/verify/${encodeURIComponent(payment.providerReference)}`);
  if (!data.status) { // do not downgrade/fail on a lookup error, but DO tell the caller why (e.g. "Invalid key" means the wrong PAYSTACK_SECRET_KEY on the server)
    console.error('[subscription verify]', payment.providerReference, data.message);
    return { status: 'pending', message: `Paystack could not confirm this yet (${data.message || 'no reason given'}). We will keep checking.` };
  }
  const t = data.data;
  if (t.status === 'success' && t.amount === payment.amount * 100 && t.currency === 'NGN') {
    await activateFromPayment(payment);
    return { status: 'success' };
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
