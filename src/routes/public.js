import { Router } from 'express';
import mongoose from 'mongoose';
import { Restaurant, Category, Meal, Order, PaymentConfig, Subscription } from '../models/index.js';
import { z, validate, wrap, orderRef, randomToken, sha256, normalisePhone, naira } from '../utils/helpers.js';
import { autocomplete, quoteDelivery, validPlaceId, placesConfigured } from '../services/places.js';
import { isProActive } from '../services/subscription.js';
import { sendEmail, btn } from '../services/email.js';
import { startOrderPayment } from '../services/orderPayments.js';
import { notifyRestaurant } from '../services/notify.js';
import { getCached, setCached } from '../services/publicCache.js';

const r = Router();

async function findRestaurant(key, byDomain = false) {
  const q = byDomain ? { customDomain: key.toLowerCase(), customDomainStatus: 'verified' } : { slug: key.toLowerCase() };
  const rest = await Restaurant.findOne(q);
  if (!rest || rest.status !== 'active') return null;
  const sub = await Subscription.findOne({ restaurant: rest._id }).lean(); // PERF: plain object, read-only
  const isPro = isProActive(sub);
  if (byDomain && !isPro) return null; // custom domains only serve while Pro is active
  return { rest, isPro };
}

function isOpenNow(rest) {
  if (!rest.acceptingOrders) return false;
  if (!rest.openingHours?.length) return true;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  const today = rest.openingHours.find((h) => h.day === now.getDay());
  if (!today) return true;
  if (today.closed) return false;
  const [oh, om] = today.open.split(':').map(Number), [ch, cm] = today.close.split(':').map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= oh * 60 + om && mins <= ch * 60 + cm;
}

async function publicPayload(found) {
  const { rest, isPro } = found;
  const [categories, meals, cfg] = await Promise.all([
    Category.find({ restaurant: rest._id }).sort('sort name').lean(),
    Meal.find({ restaurant: rest._id }).sort('name').lean(),
    isPro ? PaymentConfig.findOne({ restaurant: rest._id }).select('bank.bankName bank.accountName +bank.accountNumber onboardingStatus') : null,
  ]);
  // Delivery is offered only when the owner turned it on AND finished the radius setup AND address search works.
  const f = rest.fulfillment;
  const deliveryOn = !!(f.deliveryEnabled && f.radius?.configured && f.location?.lat != null && placesConfigured());
  const pay = rest.payments;
  return {
    restaurant: {
      name: rest.name, slug: rest.slug, description: rest.description, logo: rest.logo, cover: rest.cover,
      phone: rest.phone, address: rest.address, state: rest.state, openingHours: rest.openingHours,
      accent: rest.theme?.accent, isOpen: isOpenNow(rest), plan: isPro ? 'pro' : 'free',
      whatsapp: rest.whatsapp,
    },
    categories,
    meals: meals.map((m) => ({
      _id: m._id, name: m.name, description: m.description, price: m.price, image: m.image, category: m.category,
      available: m.available, prepTime: m.prepTime, portion: m.portion, tags: m.tags || [], popular: !!m.popular,
      addons: (m.addons || []).filter((a) => a.available !== false)
        .map((a) => ({ _id: String(a._id), name: a.name, price: a.price, group: a.group || 'Extras' })),
    })),
    checkout: isPro ? {
      fulfillment: {
        delivery: deliveryOn,
        pickup: rest.fulfillment.pickupEnabled,
        dineIn: rest.fulfillment.dineInEnabled,
        pickupInstructions: rest.fulfillment.pickupInstructions,
        askTableNumber: rest.fulfillment.askTableNumber,
      },
      deliveryRules: deliveryOn ? { baseFee: f.radius.baseFee, baseDistanceKm: f.radius.baseDistanceKm, perKmRate: f.radius.perKmRate, maxRadiusKm: f.radius.maxRadiusKm } : null,
      payments: {
        paystack: pay.paystackEnabled && cfg?.onboardingStatus === 'active',
        bankTransfer: pay.bankTransferEnabled && !!cfg?.bank?.accountNumber,
        pod: pay.podEnabled,
      },
      // bank details only exposed when bank transfer enabled
      bank: pay.bankTransferEnabled && cfg?.bank?.accountNumber ? { bankName: cfg.bank.bankName, accountName: cfg.bank.accountName, accountNumber: cfg.bank.accountNumber } : null,
    } : null,
  };
}

// PERF (changed): public pages are served from a 30-second server cache, and browsers/CDNs may reuse the response for 10 seconds
// (stale-while-revalidate lets them show it instantly while refreshing). The data is public and the cache is cleared whenever the owner edits anything.
const PUBLIC_CACHE_HEADER = 'public, max-age=10, stale-while-revalidate=60';
async function servePublic(res, key, find, notFound) {
  const hit = getCached(key);
  if (hit) { res.set('Cache-Control', PUBLIC_CACHE_HEADER); return res.json(hit); }
  const f = await find();
  if (!f) return res.status(404).json({ error: notFound });
  const payload = await publicPayload(f);
  setCached(key, payload);
  res.set('Cache-Control', PUBLIC_CACHE_HEADER);
  return res.json(payload);
}

r.get('/by-domain/:domain', wrap((req, res) => servePublic(res, `d:${req.params.domain.toLowerCase()}`, () => findRestaurant(req.params.domain, true), 'Not found')));

r.get('/r/:slug', wrap((req, res) => servePublic(res, `s:${req.params.slug.toLowerCase()}`, () => findRestaurant(req.params.slug), 'Restaurant not found')));

/* ---------- Cart pricing: ALWAYS from DB (meal price + chosen add-ons) ---------- */
const cartSchema = z.array(z.object({
  mealId: z.string(), quantity: z.number().int().min(1).max(50), addonIds: z.array(z.string()).max(20).optional(),
})).min(1).max(60);

async function priceCart(rest, cart) {
  const ids = [...new Set(cart.map((c) => c.mealId))].filter((id) => mongoose.isValidObjectId(id));
  // PERF (changed): only the fields needed to price the cart, as plain objects (.lean()) instead of full Mongoose documents.
  const meals = await Meal.find({ _id: { $in: ids }, restaurant: rest._id }).select('name price available addons').lean();
  const map = new Map(meals.map((m) => [String(m._id), m]));
  const unavailable = [], items = [];
  for (const c of cart) {
    const m = map.get(c.mealId);
    if (!m || !m.available) { unavailable.push(c.mealId); continue; }
    const picked = []; let bad = false;
    for (const id of new Set(c.addonIds || [])) {
      const a = m.addons.find((x) => String(x._id) === id && x.available !== false);
      if (!a) { bad = true; break; }
      picked.push({ name: a.name, price: a.price });
    }
    if (bad) { unavailable.push(c.mealId); continue; }
    const unit = m.price + picked.reduce((s, a) => s + a.price, 0);
    // `price` is the per-unit price INCLUDING add-ons so totals everywhere are simply price x quantity.
    items.push({ meal: m._id, name: m.name, basePrice: m.price, addons: picked, price: unit, quantity: c.quantity });
  }
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  return { items, unavailable, subtotal };
}

r.post('/r/:slug/validate-cart', validate(z.object({ cart: cartSchema })), wrap(async (req, res) => {
  const f = await findRestaurant(req.params.slug);
  if (!f) return res.status(404).json({ error: 'Not found' });
  const { items, unavailable, subtotal } = await priceCart(f.rest, req.body.cart);
  res.json({ items, unavailable, subtotal });
}));

/* ---------- FREE: WhatsApp order intent ---------- */
r.post('/r/:slug/whatsapp-order', validate(z.object({
  cart: cartSchema, customerName: z.string().max(80).optional(), customerPhone: z.string().max(20).optional(),
  notes: z.string().max(300).optional(), idempotencyKey: z.string().max(80).optional(),
})), wrap(async (req, res) => {
  const f = await findRestaurant(req.params.slug);
  if (!f) return res.status(404).json({ error: 'Not found' });
  const { rest } = f;
  if (!isOpenNow(rest)) return res.status(409).json({ error: 'This restaurant is not accepting orders right now.' });
  if (!rest.whatsapp) return res.status(409).json({ error: 'This restaurant has not set up WhatsApp ordering yet.' });

  if (req.body.idempotencyKey) {
    const dup = await Order.findOne({ restaurant: rest._id, idempotencyKey: req.body.idempotencyKey });
    if (dup) return res.json(waResponse(rest, dup));
  }
  const { items, unavailable, subtotal } = await priceCart(rest, req.body.cart);
  if (unavailable.length) return res.status(409).json({ error: 'Some items or options are no longer available', unavailable });

  const order = await Order.create({
    restaurant: rest._id, reference: orderRef(), channel: 'whatsapp',
    customerName: req.body.customerName, customerPhone: req.body.customerPhone && normalisePhone(req.body.customerPhone),
    items, subtotal, total: subtotal, fulfillment: 'whatsapp_pickup',
    paymentMethod: 'none', paymentStatus: 'not_required', status: 'awaiting_whatsapp',
    notes: req.body.notes, idempotencyKey: req.body.idempotencyKey,
  });
  sendEmail({ to: rest.email, type: 'order_intent', restaurant: rest._id, order: order._id, dedupeKey: `intent:${order._id}`,
    subject: `New WhatsApp order intent ${order.reference}`,
    body: `<p>A customer started an order (${naira(subtotal)}). It is <b>not confirmed</b> until they message you on WhatsApp.</p>${btn(`${process.env.CLIENT_URL}/dashboard/orders`, 'Open orders')}` });
  notifyRestaurant(rest._id, { title: 'New WhatsApp order request', body: `${order.reference} · ${naira(subtotal)}`, url: '/dashboard/orders', tag: `order-${order._id}` });
  res.status(201).json(waResponse(rest, order));
}));

function waResponse(rest, order) {
  const lines = [
    `*${rest.name}*`, `Order ref: ${order.reference}`, '',
    ...order.items.map((i) => {
      const extras = i.addons?.length ? ` (+ ${i.addons.map((a) => a.name).join(', ')})` : '';
      return `• ${i.quantity} x ${i.name}${extras} — ${naira(i.price)} each (${naira(i.price * i.quantity)})`;
    }),
    '', `Subtotal: ${naira(order.subtotal)}`,
  ];
  if (order.customerName) lines.push(`Name: ${order.customerName}`);
  if (order.customerPhone) lines.push(`Phone: ${order.customerPhone}`);
  if (order.notes) lines.push(`Notes: ${order.notes}`);
  lines.push('', 'Pickup / arrangement to be confirmed with the restaurant.');
  return {
    reference: order.reference,
    whatsappUrl: `https://wa.me/${rest.whatsapp}?text=${encodeURIComponent(lines.join('\n'))}`,
    restaurantWhatsapp: rest.whatsapp,
    note: 'Your order is only a request until the restaurant confirms it on WhatsApp.',
  };
}

/* ---------- PRO: checkout ---------- */
const quoteSchema = z.object({ placeId: z.string().max(2000), sessionToken: z.string().max(64).optional() });

// Address suggestions for the delivery box, biased towards the restaurant. Goes through our server, so no Google key in the browser.
r.post('/r/:slug/places/autocomplete', validate(z.object({ input: z.string().min(3).max(120), sessionToken: z.string().max(64).optional() })), wrap(async (req, res) => {
  const found = await findRestaurant(req.params.slug);
  if (!found?.isPro) return res.status(404).json({ error: 'Not found' });
  const f = found.rest.fulfillment;
  if (!f?.radius?.configured || f.location?.lat == null) return res.json({ suggestions: [] });
  res.json({ suggestions: await autocomplete(req.body.input, { sessionToken: req.body.sessionToken, bias: { lat: f.location.lat, lng: f.location.lng, radiusM: f.radius.maxRadiusKm * 1000 } }) });
}));

// Price check shown at checkout. The same calculation is repeated when the order is placed.
r.post('/r/:slug/delivery-quote', validate(quoteSchema), wrap(async (req, res) => {
  const found = await findRestaurant(req.params.slug);
  if (!found?.isPro || !found.rest.fulfillment.deliveryEnabled) return res.status(404).json({ error: 'Delivery is not offered' });
  const q = await quoteDelivery(found.rest, req.body.placeId, req.body.sessionToken);
  if (!q.ok) return res.status(422).json({ error: `Sorry, that address is outside ${found.rest.name}'s delivery range (${found.rest.fulfillment.radius.maxRadiusKm} km).`, distanceKm: q.distanceKm });
  res.json({ fee: q.fee, distanceKm: q.distanceKm, address: q.place.address });
}));

const checkoutSchema = z.object({
  cart: cartSchema,
  customerName: z.string().min(2).max(80), customerEmail: z.string().email(), customerPhone: z.string().min(10).max(20),
  fulfillment: z.enum(['delivery', 'pickup', 'dine_in']),
  deliveryPlaceId: z.string().max(300).optional(), deliveryAddress: z.string().max(300).optional(), tableNumber: z.string().max(20).optional(),
  paymentMethod: z.enum(['paystack', 'bank_transfer', 'pod']),
  notes: z.string().max(300).optional(), idempotencyKey: z.string().max(80).optional(),
  confirmed: z.literal(true, { errorMap: () => ({ message: 'Please confirm your order' }) }),
});

r.post('/r/:slug/checkout', validate(checkoutSchema), wrap(async (req, res) => {
  const f = await findRestaurant(req.params.slug);
  if (!f) return res.status(404).json({ error: 'Not found' });
  const { rest, isPro } = f; const b = req.body;
  if (!isPro) return res.status(402).json({ error: 'Online checkout is not available for this restaurant', code: 'PRO_REQUIRED' });
  if (!isOpenNow(rest)) return res.status(409).json({ error: 'This restaurant is not accepting orders right now.' });

  if (b.idempotencyKey) {
    const dup = await Order.findOne({ restaurant: rest._id, idempotencyKey: b.idempotencyKey });
    if (dup) return res.json({ reference: dup.reference, trackingPath: null, duplicate: true });
  }
  const { items, unavailable, subtotal } = await priceCart(rest, b.cart);
  if (unavailable.length) return res.status(409).json({ error: 'Some items or options are no longer available. Please update your cart.', unavailable });

  // Fulfilment validation + delivery fee: radius formula on the server, from the restaurant's saved location (never from the browser)
  let deliveryFee = 0, deliveryPlace, deliveryDistanceKm, deliveryLocation;
  if (b.fulfillment === 'delivery') {
    if (!rest.fulfillment.deliveryEnabled) return res.status(400).json({ error: 'Delivery is not offered' });
    if (!validPlaceId(b.deliveryPlaceId)) return res.status(400).json({ error: 'Please search for your address and pick it from the list.' });
    const q = await quoteDelivery(rest, b.deliveryPlaceId);
    if (!q.ok) return res.status(400).json({ error: `Sorry, that address is outside our delivery range (${rest.fulfillment.radius.maxRadiusKm} km). Please choose pickup instead.` });
    deliveryFee = q.fee; deliveryPlace = q.place.address; deliveryDistanceKm = q.distanceKm; deliveryLocation = { lat: q.place.lat, lng: q.place.lng };
    if (!b.deliveryAddress || b.deliveryAddress.trim().length < 3) return res.status(400).json({ error: 'Please add your house name or number and any landmark' });
  } else if (b.fulfillment === 'pickup' && !rest.fulfillment.pickupEnabled) return res.status(400).json({ error: 'Pickup is not offered' });
  else if (b.fulfillment === 'dine_in' && !rest.fulfillment.dineInEnabled) return res.status(400).json({ error: 'Dine-in is not offered' });

  // Payment method validation
  const cfg = await PaymentConfig.findOne({ restaurant: rest._id }).select('+bank.accountNumber onboardingStatus');
  if (b.paymentMethod === 'paystack' && !(rest.payments.paystackEnabled && cfg?.onboardingStatus === 'active')) return res.status(400).json({ error: 'Online payment is not available' });
  if (b.paymentMethod === 'bank_transfer' && !(rest.payments.bankTransferEnabled && cfg?.bank?.accountNumber)) return res.status(400).json({ error: 'Bank transfer is not available' });
  if (b.paymentMethod === 'pod' && !rest.payments.podEnabled) return res.status(400).json({ error: 'Pay on delivery is not available' });
  if (b.paymentMethod === 'pod' && b.fulfillment !== 'delivery') return res.status(400).json({ error: 'Pay on delivery applies to delivery orders only' });

  const token = randomToken(24);
  const paymentStatus = { paystack: 'awaiting_payment', bank_transfer: 'awaiting_payment', pod: 'unpaid_pod' }[b.paymentMethod];
  const order = await Order.create({
    restaurant: rest._id, reference: orderRef(), channel: 'checkout', trackingTokenHash: sha256(token),
    customerName: b.customerName, customerEmail: b.customerEmail, customerPhone: normalisePhone(b.customerPhone),
    items, subtotal, deliveryFee, total: subtotal + deliveryFee,
    fulfillment: b.fulfillment, deliveryPlace, deliveryDistanceKm, deliveryLocation, deliveryAddress: b.deliveryAddress, tableNumber: b.tableNumber,
    paymentMethod: b.paymentMethod, paymentStatus, status: 'pending', notes: b.notes, idempotencyKey: b.idempotencyKey,
  });

  const trackUrl = `${process.env.CLIENT_URL}/track/${token}`;
  // Paystack: start the payment right now so the customer goes straight to the payment page (no extra page or tap).
  let paymentUrl;
  if (b.paymentMethod === 'paystack') {
    try { paymentUrl = (await startOrderPayment(order, rest, `${trackUrl}?pay=1`)).authorizationUrl; }
    catch (e) { console.error('[checkout] could not start payment', e.message); } // the tracking page still offers "Pay now"
  }
  // Emails after save; failures never affect the order
  sendEmail({ to: b.customerEmail, type: 'order_confirmation', restaurant: rest._id, order: order._id, dedupeKey: `conf:${order._id}`,
    subject: `Order ${order.reference} received`,
    body: `<p>Thanks ${b.customerName}! Total: <b>${naira(order.total)}</b>.</p>${btn(trackUrl, 'Track your order')}` });
  // Orders that need money first are announced to the restaurant only once payment is confirmed or proof is uploaded.
  if (b.paymentMethod === 'pod') {
    sendEmail({ to: rest.email, type: 'new_order', restaurant: rest._id, order: order._id, dedupeKey: `new:${order._id}`,
      subject: `New order ${order.reference}`, body: `<p>${naira(order.total)} via ${b.fulfillment}.</p>${btn(`${process.env.CLIENT_URL}/dashboard/orders`, 'Open orders')}` });
    notifyRestaurant(rest._id, { title: 'New order', body: `${order.reference} · ${naira(order.total)} (pay on delivery)`, url: '/dashboard/orders', tag: `order-${order._id}` });
  }

  res.status(201).json({
    reference: order.reference, total: order.total, subtotal, deliveryFee, trackingToken: token,
    paymentMethod: b.paymentMethod, paymentStatus, paymentUrl,
    next: b.paymentMethod === 'paystack' ? 'pay_online' : b.paymentMethod === 'bank_transfer' ? 'upload_proof' : 'done',
  });
}));

/* ---------- Tracking (Pro only) ---------- */
r.get('/track/:token', wrap(async (req, res) => {
  const order = await Order.findOne({ trackingTokenHash: sha256(req.params.token) }).lean();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const rest = await Restaurant.findById(order.restaurant).lean();
  res.json({
    reference: order.reference, restaurant: rest.name, restaurantSlug: rest.slug,
    items: order.items.map(({ name, quantity, price, addons }) => ({ name, quantity, price, addons })),
    subtotal: order.subtotal, deliveryFee: order.deliveryFee, total: order.total, fulfillment: order.fulfillment,
    pickupAddress: order.fulfillment === 'pickup' ? rest.address : undefined,
    deliveryAddress: order.deliveryAddress ? `${order.deliveryAddress}${order.deliveryPlace ? ', ' + order.deliveryPlace : ''}` : undefined,
    status: order.status, paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod, updatedAt: order.updatedAt,
  });
}));

export default r;
