import { Router, raw } from 'express';
import crypto from 'crypto';
import { SubscriptionPayment, OrderPayment, WebhookEvent } from '../models/index.js';
import { verifyOrderPayment } from '../services/orderPayments.js';
import { wrap, randomToken } from '../utils/helpers.js';
import { requireAuth, loadRestaurant } from '../middleware/auth.js';
import { activateFromPayment, ensureSubscription } from '../services/subscription.js';
import { getPlanConfig } from '../services/settings.js';

const PS = 'https://api.paystack.co';
const ps = (path, opts = {}) => fetch(PS + path, {
  ...opts,
  signal: AbortSignal.timeout(12000),
  headers: {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  },
}).then((r) => r.json()).catch((e) => ({
  status: false,
  message: e.name === 'TimeoutError' ? 'Paystack took too long to respond.' : 'Could not reach Paystack.',
}));

const parseMeta = (m) => {
  if (!m) return {};
  if (typeof m === 'string') {
    try { return JSON.parse(m) || {}; } catch { return {}; }
  }
  return m;
};

export const subscriptionRouter = Router();
subscriptionRouter.use(requireAuth, loadRestaurant);

subscriptionRouter.get('/', wrap(async (req, res) => {
  const payments = await SubscriptionPayment.find({ restaurant: req.restaurant._id }).sort('-createdAt').limit(20).lean();
  const cfg = await getPlanConfig();
  res.json({ subscription: req.subscription, isPro: req.isPro, price: cfg.pro.priceNgn, payments });
}));

subscriptionRouter.post('/checkout', wrap(async (req, res) => {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    return res.status(503).json({ error: 'Subscription payments are not configured yet (PAYSTACK_SECRET_KEY missing).' });
  }

  const cfg = await getPlanConfig();
  const sub = await ensureSubscription(req.restaurant._id);
  const reference = 'SUB-' + randomToken(10);
  const amount = cfg.pro.priceNgn;
  const payment = await SubscriptionPayment.create({
    restaurant: req.restaurant._id,
    subscription: sub._id,
    providerReference: reference,
    amount,
  });

  const data = await ps('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email: req.user.email,
      amount: amount * 100,
      reference,
      currency: 'NGN',
      callback_url: `${process.env.CLIENT_URL}/dashboard/subscription?ref=${reference}`,
      metadata: {
        purpose: 'pro_subscription',
        restaurantId: String(req.restaurant._id),
      },
    }),
  });

  if (!data.status) {
    payment.status = 'failed';
    await payment.save();
    return res.status(502).json({ error: data.message || 'Could not start payment' });
  }

  res.json({ authorizationUrl: data.data.authorization_url, reference });
}));

subscriptionRouter.post('/verify', wrap(async (req, res) => {
  const reference = req.body?.reference || req.query?.ref;
  if (!reference) return res.status(400).json({ error: 'Missing payment reference' });

  const payment = await SubscriptionPayment.findOne({
    providerReference: String(reference),
    restaurant: req.restaurant._id,
  });

  if (!payment) return res.status(404).json({ error: 'Payment not found' });

  try {
    res.json(await verifySubscriptionPayment(payment));
  } catch (e) {
    console.error('[subscription verify]', e);
    res.status(500).json({
      error: 'Payment was found but we could not finish activating Pro. Please try "Check status" again in a moment.',
    });
  }
}));

export async function verifySubscriptionPayment(payment) {
  if (payment.status === 'success') return { status: 'success' };

  const data = await ps(`/transaction/verify/${encodeURIComponent(payment.providerReference)}`);
  if (!data.status) {
    console.error('[subscription verify] Paystack lookup failed (left pending for retry)', {
      reference: payment.providerReference,
      message: data.message,
    });
    return { status: 'pending', message: `Paystack verification error: ${data.message || 'Unknown error'}` };
  }

  const t = data.data;

  if (t.status === 'success') {
    const expectedKobo = Math.round(Number(payment.amount) * 100);
    const meta = parseMeta(t.metadata);
    const belongsHere = !meta.restaurantId || String(meta.restaurantId) === String(payment.restaurant);

    const paidKobo = Math.round(Number(t.amount));
    const amountOk = Number.isFinite(paidKobo) && paidKobo === expectedKobo;
    const currencyOk = String(t.currency || '').toUpperCase() === 'NGN';

    // Build diagnostics like we do for order payments
    const discrepancies = [];
    if (paidKobo !== expectedKobo) {
      discrepancies.push({ field: 'amount', expectedKobo, actualKobo: t.amount });
    }
    if (!currencyOk) {
      discrepancies.push({ field: 'currency', expected: 'NGN', actual: t.currency });
    }
    if (meta.restaurantId !== undefined && meta.restaurantId !== null && String(meta.restaurantId) !== String(payment.restaurant)) {
      discrepancies.push({ field: 'metadata.restaurantId', expected: String(payment.restaurant), actual: String(meta.restaurantId) });
    }
    if (t.reference && payment.providerReference && String(t.reference) !== String(payment.providerReference)) {
      discrepancies.push({ field: 'reference', expected: payment.providerReference, actual: t.reference });
    }

    if (discrepancies.length) {
      console.warn('[subscription verify] Paystack success has record discrepancies:', {
        providerReference: payment.providerReference,
        paystackReference: t.reference,
        discrepancies,
        metadata: t.metadata,
      });
    }

    // Claim the payment atomically and record raw payload + discrepancies.
    const claimed = await SubscriptionPayment.findOneAndUpdate(
      { _id: payment._id, status: { $ne: 'success' } },
      {
        status: 'success',
        verifiedAt: new Date(),
        raw: {
          id: t.id,
          reference: t.reference,
          paid_at: t.paid_at,
          amount: t.amount,
          currency: t.currency,
          metadata: t.metadata,
          expectedKobo,
          discrepancies,
        },
      },
      { new: true }
    );

    // If another worker already processed it, treat as success.
    if (!claimed) return { status: 'success' };

    // Try to activate subscription. Activation errors must not make paystack/webhook fail.
    try {
      // activateFromPayment will perform its own claim if needed and then finish activation.
      await activateFromPayment(payment).catch((e) => {
        console.error('[subscription verify] activateFromPayment failed (record kept success)', { paymentId: payment._id, err: e });
      });

      // Optionally update the payment raw again with activation status if needed.
      const fresh = await SubscriptionPayment.findById(payment._id).lean();
      return { status: fresh?.status === 'success' ? 'success' : 'pending' };
    } catch (e) {
      // Should not happen because activateFromPayment catches; but guard anyway.
      console.error('[subscription verify] unexpected activation error', e);
      return { status: 'success' }; // Payment is claimed; do not surface error to caller/provider.
    }
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

  if (!sig || sig.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hash))) {
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  const event = JSON.parse(req.body.toString());
  const ref = event.data?.reference;
  const eventId = `${event.event}:${event.data?.id || ref}`;

  try {
    await WebhookEvent.create({ provider: 'paystack', eventId, type: event.event });
  } catch {
    return;
  }

  if (event.event === 'charge.success' && ref?.startsWith('SUB-')) {
    const payment = await SubscriptionPayment.findOne({ providerReference: ref });
    if (payment) await verifySubscriptionPayment(payment);
  }

  if (event.event === 'charge.success' && ref?.startsWith('FOD-')) {
    const op = await OrderPayment.findOne({ providerReference: ref });
    if (op) await verifyOrderPayment(op);
  }
}));