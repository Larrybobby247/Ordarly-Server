import { Router } from 'express';
import mongoose from 'mongoose';
import { Restaurant, Category, Meal, Order, PaymentConfig, Subscription, Branch } from '../models/index.js';
import { z, validate, wrap, orderRef, randomToken, sha256, normalisePhone, naira } from '../utils/helpers.js';
import { autocomplete, quoteDelivery, validPlaceId, placesConfigured } from '../services/places.js';
import { planOf } from '../services/subscription.js';
import { sendEmail, btn } from '../services/email.js';
import { startOrderPayment } from '../services/orderPayments.js';
import { notifyRestaurant } from '../services/notify.js';
import { getCached, setCached } from '../services/publicCache.js';
import { SERVING, publicBaseFor, platformSubdomainSlug, platformDomain } from '../services/customDomain.js';
import { cleanHostInput, isPlatformHost } from '../services/domainUtils.js';
import { activeBranches, effectiveRestaurant, applyOverride, overrideMap } from '../services/branches.js';
import { getPlanConfig } from '../services/settings.js';
import { commissionPctFor, RESERVED_SLUGS } from '../config/plans.js';
import { commissionOf } from '../services/earningsMath.js';
import { schedulingOf, generateSlots, isValidSlot, candidateDates } from '../services/schedule.js';
import { bookedCounts, reserveSlot, releaseSlotRaw } from '../services/scheduling.js';
import { tzOf, formatLocal, localDay, startOfLocalDay, addLocalDays, zonedToUtc } from '../services/tz.js';

const r = Router();

async function findRestaurant(key, byDomain = false) {
  // Hostname lookups only ever match a domain that is ACTIVE (or a legacy-verified one awaiting re-check); unverified claims never resolve.
  // <slug>.<platform domain> is a subdomain of Ordarly itself, so it resolves for every plan.
  const sub = byDomain ? platformSubdomainSlug(key) : null;
  const q = byDomain ? (sub ? { slug: sub } : { customDomain: key.toLowerCase(), ...SERVING }) : { slug: key.toLowerCase() };
  const rest = await Restaurant.findOne(q);
  if (!rest || rest.status !== 'active') return null;
  const subscription = await Subscription.findOne({ restaurant: rest._id }).lean(); // PERF: plain object, read-only
  const plan = planOf(subscription);
  const isPro = plan !== 'free'; // Pro and Business both unlock every Pro feature
  if (byDomain && !sub && !isPro) return null; // custom domains only serve while a paid plan is active
  return { rest, isPro, plan };
}

/** Which branch (if any) this request is about. Only the Business plan has branches; everyone else keeps the single-location flow. */
async function branchContext(found, branchId) {
  if (found.plan !== 'business') return { branches: [], branch: null, required: false };
  const branches = await activeBranches(found.rest._id);
  if (!branches.length) return { branches: [], branch: null, required: false };
  if (branchId) {
    const branch = branches.find((x) => String(x._id) === String(branchId));
    return branch ? { branches, branch, required: false } : { branches, branch: null, required: false, error: 'That branch is not available.' };
  }
  if (branches.length === 1) return { branches, branch: branches[0], required: false }; // single active branch: skip the picker
  return { branches, branch: null, required: true };
}

/** Is the restaurant (or branch, via effectiveRestaurant) taking ASAP orders right now? Uses the restaurant's own time zone. */
export function isOpenNow(rest, now = new Date()) {
  if (!rest.acceptingOrders) return false;
  if (!rest.openingHours?.length) return true;
  const tz = tzOf(rest);
  const l = localDay(now, tz);
  const today = rest.openingHours.find((h) => h.day === l.dow);
  if (!today) return true;
  if (today.closed) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(now).map((p) => [p.type, p.value]));
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  const [oh, om] = today.open.split(':').map(Number), [ch, cm] = today.close.split(':').map(Number);
  return mins >= oh * 60 + om && mins <= ch * 60 + cm;
}

const deliveryOn = (er) => !!(er.fulfillment?.deliveryEnabled && er.fulfillment.radius?.configured && er.fulfillment.location?.lat != null && placesConfigured());

async function publicPayload(found, ctx) {
  const { rest, isPro, plan } = found;
  const er = effectiveRestaurant(rest, ctx.branch);
  const [categories, meals, cfg, ovs] = await Promise.all([
    Category.find({ restaurant: rest._id }).sort('sort name').lean(),
    ctx.required ? [] : Meal.find({ restaurant: rest._id }).sort('name').lean(), // no menu until the customer has chosen a branch
    PaymentConfig.findOne({ restaurant: rest._id }).select('bank.bankName bank.accountName +bank.accountNumber onboardingStatus'),
    overrideMap(ctx.branch?._id),
  ]);
  const f = er.fulfillment;
  const dOn = deliveryOn(er);
  const pay = rest.payments;
  // Free restaurants take online (Paystack) payments only; bank transfer and pay-on-delivery are Pro features.
  const payments = {
    paystack: !!(pay.paystackEnabled && cfg?.onboardingStatus === 'active'),
    bankTransfer: isPro && !!(pay.bankTransferEnabled && cfg?.bank?.accountNumber),
    pod: isPro && !!pay.podEnabled,
  };
  const sch = schedulingOf(rest);
  const branchCards = ctx.branches.map((b) => {
    const e = effectiveRestaurant(rest, b);
    return { _id: String(b._id), name: b.name, address: e.address, phone: e.phone, isOpen: isOpenNow(e), delivery: deliveryOn(e), pickup: !!e.fulfillment.pickupEnabled, dineIn: !!e.fulfillment.dineInEnabled, prepTime: e.prepTimeMinutes, openingHours: e.openingHours };
  });
  return {
    restaurant: {
      name: rest.name, slug: rest.slug, description: rest.description, logo: rest.logo, cover: rest.cover,
      phone: er.phone, address: er.address, state: rest.state, openingHours: er.openingHours,
      accent: rest.theme?.accent, isOpen: isOpenNow(er), plan,
      whatsapp: er.whatsapp, prepTime: er.prepTimeMinutes ?? null,
    },
    branches: branchCards,
    branch: ctx.branch ? branchCards.find((b) => b._id === String(ctx.branch._id)) : null,
    branchRequired: !!ctx.required,
    categories,
    meals: meals.map((m0) => {
      const m = applyOverride(m0, ovs.get(String(m0._id)));
      return {
        _id: m._id, name: m.name, description: m.description, price: m.price, image: m.image, category: m.category,
        available: m.available, prepTime: m.prepTime, portion: m.portion, tags: m.tags || [], popular: !!m.popular,
        sizes: (m.sizes || []).filter((z) => z.available !== false).map((z) => ({ _id: String(z._id), name: z.name, price: z.price })),
        addons: (m.addons || []).filter((a) => a.available !== false)
          .map((a) => ({ _id: String(a._id), name: a.name, price: a.price, group: a.group || 'Extras' })),
      };
    }),
    // Online ordering is open to every plan once at least one payment method works; otherwise customers use the WhatsApp flow.
    checkout: (payments.paystack || payments.bankTransfer || payments.pod) ? {
      fulfillment: {
        delivery: dOn,
        pickup: !!f.pickupEnabled,
        dineIn: !!f.dineInEnabled,
        pickupInstructions: f.pickupInstructions,
        askTableNumber: rest.fulfillment.askTableNumber,
      },
      deliveryRules: dOn ? { baseFee: f.radius.baseFee, baseDistanceKm: f.radius.baseDistanceKm, perKmRate: f.radius.perKmRate, maxRadiusKm: f.radius.maxRadiusKm } : null,
      payments,
      bank: payments.bankTransfer ? { bankName: cfg.bank.bankName, accountName: cfg.bank.accountName, accountNumber: cfg.bank.accountNumber } : null,
      scheduling: sch.enabled ? { enabled: true, maxDaysAhead: sch.maxDaysAhead, minNoticeMinutes: sch.minNoticeMinutes, slotMinutes: sch.slotMinutes, timezone: sch.timezone } : { enabled: false },
    } : null,
  };
}

// PERF (changed): public pages are served from a 30-second server cache, and browsers/CDNs may reuse the response for 10 seconds
// (stale-while-revalidate lets them show it instantly while refreshing). The data is public and the cache is cleared whenever the owner edits anything.
const PUBLIC_CACHE_HEADER = 'public, max-age=10, stale-while-revalidate=60';
async function servePublic(res, key, find, notFound, code, branchId) {
  const ck = `${key}|${branchId || ''}`;
  const hit = getCached(ck);
  if (hit) { res.set('Cache-Control', PUBLIC_CACHE_HEADER); return res.json(hit); }
  const f = await find();
  if (!f) return res.status(404).json({ error: notFound, ...(code ? { code } : {}) });
  const ctx = await branchContext(f, branchId);
  if (ctx.error) return res.status(404).json({ error: ctx.error, code: 'BRANCH_NOT_FOUND' });
  const payload = await publicPayload(f, ctx);
  setCached(ck, payload);
  res.set('Cache-Control', PUBLIC_CACHE_HEADER);
  return res.json(payload);
}

// Hostname-based identification. The hostname is validated and normalised; unknown, unverified or disconnected domains get a clear 404.
// Platform hostnames answer { platform: true } so the frontend can tell "this is Ordarly itself" from "unknown domain" without guessing.
// <slug>.<platform domain> resolves to that restaurant.
const validBranchId = (v) => (typeof v === 'string' && mongoose.isValidObjectId(v) ? v : undefined);
r.get('/by-domain/:domain', wrap((req, res) => {
  const host = cleanHostInput(req.params.domain);
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return res.status(404).json({ error: 'This address is not connected to a restaurant.', code: 'DOMAIN_NOT_FOUND' });
  // Ordarly's own hostnames, including reserved subdomains such as app.<platform domain>, show the Ordarly site, never "not found".
  const root = platformDomain();
  if (isPlatformHost(host) || (host.endsWith('.' + root) && RESERVED_SLUGS.has(host.slice(0, -(root.length + 1))))) return res.json({ platform: true });
  return servePublic(res, `d:${host}`, () => findRestaurant(host, true), 'This address is not connected to a restaurant.', 'DOMAIN_NOT_FOUND', validBranchId(req.query.branch));
}));

r.get('/r/:slug', wrap((req, res) => servePublic(res, `s:${req.params.slug.toLowerCase()}`, () => findRestaurant(req.params.slug), 'Restaurant not found', undefined, validBranchId(req.query.branch))));

/* ---------- Cart pricing: ALWAYS from DB (meal price + chosen add-ons) ---------- */
const cartSchema = z.array(z.object({
  mealId: z.string(), quantity: z.number().int().min(1).max(50), sizeId: z.string().max(40).optional(), addonIds: z.array(z.string()).max(20).optional(),
})).min(1).max(60);

async function priceCart(rest, cart, branchId) {
  const ids = [...new Set(cart.map((c) => c.mealId))].filter((id) => mongoose.isValidObjectId(id));
  // PERF (changed): only the fields needed to price the cart, as plain objects (.lean()) instead of full Mongoose documents.
  const meals = await Meal.find({ _id: { $in: ids }, restaurant: rest._id }).select('name price available addons sizes').lean();
  const ovs = await overrideMap(branchId); // this branch's price/availability differences (none for single-location restaurants)
  const map = new Map(meals.map((m) => [String(m._id), applyOverride(m, ovs.get(String(m._id)))]));
  const unavailable = [], items = [], lines = [];
  for (const [index, c] of cart.entries()) {
    const m = map.get(c.mealId);
    if (!m || !m.available) { unavailable.push(c.mealId); lines.push({ index, ok: false }); continue; }
    // Size-priced meals (e.g. 10" / 12" / 14"): a valid, available size is required and replaces the base price.
    const sizes = (m.sizes || []).filter((x) => x.available !== false);
    let basePrice = m.price, sizeName;
    if (sizes.length) {
      const sz = sizes.find((x) => String(x._id) === c.sizeId);
      if (!sz) { unavailable.push(c.mealId); lines.push({ index, ok: false }); continue; }
      basePrice = sz.price; sizeName = sz.name;
    }
    const picked = []; let bad = false;
    for (const id of new Set(c.addonIds || [])) {
      const a = m.addons.find((x) => String(x._id) === id && x.available !== false);
      if (!a) { bad = true; break; }
      picked.push({ name: a.name, price: a.price });
    }
    if (bad) { unavailable.push(c.mealId); lines.push({ index, ok: false }); continue; }
    const unit = basePrice + picked.reduce((s, a) => s + a.price, 0);
    // `price` is the per-unit price INCLUDING size + add-ons so totals everywhere are simply price x quantity.
    items.push({ meal: m._id, name: m.name, size: sizeName, basePrice, addons: picked, price: unit, quantity: c.quantity });
    lines.push({ index, ok: true, unitPrice: unit });
  }
  const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
  return { items, unavailable, subtotal, lines };
}

// Also answers "what would this cart cost at ANOTHER branch?" (the customer is switching branches): `lines` says, per cart entry, whether it
// exists there and at what unit price, so the browser can show unavailable items and price changes before anything is changed.
r.post('/r/:slug/validate-cart', validate(z.object({ cart: cartSchema, branchId: z.string().max(40).optional() })), wrap(async (req, res) => {
  const f = await findRestaurant(req.params.slug);
  if (!f) return res.status(404).json({ error: 'Not found' });
  const ctx = await branchContext(f, req.body.branchId);
  if (ctx.error) return res.status(400).json({ error: ctx.error, code: 'BRANCH_NOT_FOUND' });
  const { items, unavailable, subtotal, lines } = await priceCart(f.rest, req.body.cart, ctx.branch?._id);
  res.json({ items, unavailable, subtotal, lines });
}));

/* ---------- FREE: WhatsApp order intent ---------- */
r.post('/r/:slug/whatsapp-order', validate(z.object({
  cart: cartSchema, customerName: z.string().max(80).optional(), customerPhone: z.string().max(20).optional(),
  notes: z.string().max(300).optional(), idempotencyKey: z.string().max(80).optional(), branchId: z.string().max(40).optional(),
})), wrap(async (req, res) => {
  const f = await findRestaurant(req.params.slug);
  if (!f) return res.status(404).json({ error: 'Not found' });
  const ctx = await branchContext(f, req.body.branchId);
  if (ctx.error) return res.status(400).json({ error: ctx.error, code: 'BRANCH_NOT_FOUND' });
  if (ctx.required) return res.status(400).json({ error: 'Please choose a branch first.', code: 'BRANCH_REQUIRED' });
  const rest = effectiveRestaurant(f.rest, ctx.branch); rest._id = f.rest._id;
  if (!isOpenNow(rest)) return res.status(409).json({ error: 'This restaurant is not accepting orders right now.' });
  if (!rest.whatsapp) return res.status(409).json({ error: 'This restaurant has not set up WhatsApp ordering yet.' });

  if (req.body.idempotencyKey) {
    const dup = await Order.findOne({ restaurant: rest._id, idempotencyKey: req.body.idempotencyKey });
    if (dup) return res.json(waResponse(rest, dup));
  }
  const { items, unavailable, subtotal } = await priceCart(rest, req.body.cart, ctx.branch?._id);
  if (unavailable.length) return res.status(409).json({ error: 'Some items or options are no longer available', unavailable });

  const order = await Order.create({
    restaurant: rest._id, reference: orderRef(), channel: 'whatsapp', branch: ctx.branch?._id || null, branchName: ctx.branch?.name,
    customerName: req.body.customerName, customerPhone: req.body.customerPhone && normalisePhone(req.body.customerPhone),
    items, subtotal, total: subtotal, fulfillment: 'whatsapp_pickup',
    paymentMethod: 'none', paymentStatus: 'not_required', status: 'awaiting_whatsapp',
    notes: req.body.notes, idempotencyKey: req.body.idempotencyKey,
  });
  sendEmail({ to: rest.email, type: 'order_intent', restaurant: rest._id, order: order._id, dedupeKey: `intent:${order._id}`,
    subject: `New WhatsApp order intent ${order.reference}${order.branchName ? ' (' + order.branchName + ')' : ''}`,
    body: `<p>A customer started an order (${naira(subtotal)}). It is <b>not confirmed</b> until they message you on WhatsApp.</p>${btn(`${process.env.CLIENT_URL}/dashboard/orders`, 'Open orders')}` });
  notifyRestaurant(rest._id, { title: 'New WhatsApp order request', body: `${order.reference} · ${naira(subtotal)}`, url: '/dashboard/orders', tag: `order-${order._id}` });
  res.status(201).json(waResponse(rest, order));
}));

function waResponse(rest, order) {
  const lines = [
    `*${rest.name}${rest.branchName ? ' — ' + rest.branchName : ''}*`, `Order ref: ${order.reference}`, '',
    ...order.items.map((i) => {
      const extras = i.addons?.length ? ` (+ ${i.addons.map((a) => a.name).join(', ')})` : '';
      return `• ${i.quantity} x ${i.name}${i.size ? ` [${i.size}]` : ''}${extras} — ${naira(i.price)} each (${naira(i.price * i.quantity)})`;
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

/* ---------- Checkout (every plan; Free is online-payment only) ---------- */
const quoteSchema = z.object({ placeId: z.string().max(2000), sessionToken: z.string().max(64).optional(), branchId: z.string().max(40).optional() });

// Address suggestions for the delivery box, biased towards the restaurant (or the chosen branch). Goes through our server, so no map key in the browser.
r.post('/r/:slug/places/autocomplete', validate(z.object({ input: z.string().min(3).max(120), sessionToken: z.string().max(64).optional(), branchId: z.string().max(40).optional() })), wrap(async (req, res) => {
  const found = await findRestaurant(req.params.slug);
  if (!found) return res.status(404).json({ error: 'Not found' });
  const ctx = await branchContext(found, req.body.branchId);
  const f = effectiveRestaurant(found.rest, ctx.branch).fulfillment;
  if (!f?.radius?.configured || f.location?.lat == null) return res.json({ suggestions: [] });
  res.json({ suggestions: await autocomplete(req.body.input, { sessionToken: req.body.sessionToken, bias: { lat: f.location.lat, lng: f.location.lng, radiusM: f.radius.maxRadiusKm * 1000 } }) });
}));

// Price check shown at checkout. The same calculation is repeated when the order is placed.
r.post('/r/:slug/delivery-quote', validate(quoteSchema), wrap(async (req, res) => {
  const found = await findRestaurant(req.params.slug);
  if (!found) return res.status(404).json({ error: 'Not found' });
  const ctx = await branchContext(found, req.body.branchId);
  if (ctx.error || ctx.required) return res.status(400).json({ error: ctx.error || 'Please choose a branch first.', code: ctx.required ? 'BRANCH_REQUIRED' : 'BRANCH_NOT_FOUND' });
  const er = effectiveRestaurant(found.rest, ctx.branch);
  if (!er.fulfillment.deliveryEnabled) return res.status(404).json({ error: 'Delivery is not offered' });
  const q = await quoteDelivery(er, req.body.placeId, req.body.sessionToken);
  if (!q.ok) return res.status(422).json({ error: `Sorry, that address is outside ${found.rest.name}${ctx.branch ? ' (' + ctx.branch.name + ')' : ''}'s delivery range (${er.fulfillment.radius.maxRadiusKm} km).`, distanceKm: q.distanceKm });
  res.json({ fee: q.fee, distanceKm: q.distanceKm, address: q.place.address });
}));

/* ---------- Scheduled orders: which days / times can be booked ---------- */
// GET /r/:slug/slots?branch=<id>            -> { days: [{ date, open }] }   (days that still have at least one bookable slot)
// GET /r/:slug/slots?branch=<id>&date=YYYY-MM-DD -> { date, slots: [{ start, time, available, reason }] }
r.get('/r/:slug/slots', wrap(async (req, res) => {
  const found = await findRestaurant(req.params.slug);
  if (!found) return res.status(404).json({ error: 'Not found' });
  const ctx = await branchContext(found, validBranchId(req.query.branch));
  if (ctx.error || ctx.required) return res.status(400).json({ error: ctx.error || 'Please choose a branch first.', code: ctx.required ? 'BRANCH_REQUIRED' : 'BRANCH_NOT_FOUND' });
  const sch = schedulingOf(found.rest);
  if (!sch.enabled) return res.status(404).json({ error: 'Ordering for later is not offered.' });
  const er = effectiveRestaurant(found.rest, ctx.branch);
  const now = new Date(), tz = sch.timezone;
  const dates = candidateDates({ cfg: sch, now });
  const from = startOfLocalDay(now, tz), to = addLocalDays(now, sch.maxDaysAhead + 1, tz);
  const booked = await bookedCounts(found.rest._id, ctx.branch?._id, from, to);
  const slotsFor = (d) => generateSlots({ dateStr: d, hours: er.openingHours, cfg: sch, now, booked, acceptingOrders: er.acceptingOrders !== false });
  res.set('Cache-Control', 'no-store');
  if (req.query.date) {
    const date = String(req.query.date);
    if (!dates.includes(date)) return res.json({ date, slots: [] });
    return res.json({ date, timezone: tz, slots: slotsFor(date) });
  }
  res.json({ timezone: tz, days: dates.map((d) => ({ date: d, open: slotsFor(d).some((x) => x.available) })).filter((d) => d.open) });
}));

const checkoutSchema = z.object({
  cart: cartSchema,
  branchId: z.string().max(40).optional(),
  customerName: z.string().min(2).max(80), customerEmail: z.string().email(), customerPhone: z.string().min(10).max(20),
  fulfillment: z.enum(['delivery', 'pickup', 'dine_in']),
  deliveryPlaceId: z.string().max(1000).optional(), deliveryAddress: z.string().max(300).optional(), tableNumber: z.string().max(20).optional(),
  paymentMethod: z.enum(['paystack', 'bank_transfer', 'pod']),
  scheduledFor: z.string().datetime().optional(), // ISO instant of the chosen slot; omitted = ASAP
  notes: z.string().max(300).optional(), idempotencyKey: z.string().max(80).optional(),
  confirmed: z.literal(true, { errorMap: () => ({ message: 'Please confirm your order' }) }),
});

r.post('/r/:slug/checkout', validate(checkoutSchema), wrap(async (req, res) => {
  const f = await findRestaurant(req.params.slug);
  if (!f) return res.status(404).json({ error: 'Not found' });
  const { isPro, plan } = f; const b = req.body;
  // Branch: required for multi-branch restaurants, validated against the restaurant's ACTIVE branches (never trusted from the client).
  const ctx = await branchContext(f, b.branchId);
  if (ctx.error) return res.status(400).json({ error: ctx.error, code: 'BRANCH_NOT_FOUND' });
  if (ctx.required) return res.status(400).json({ error: 'Please choose a branch before ordering.', code: 'BRANCH_REQUIRED' });
  const rest = f.rest; const er = effectiveRestaurant(rest, ctx.branch); const branchId = ctx.branch?._id || null;
  if (!isPro && b.paymentMethod !== 'paystack') return res.status(402).json({ error: 'Only online payment is available for this restaurant.', code: 'PRO_REQUIRED' });

  const sch = schedulingOf(rest);
  if (b.scheduledFor && !sch.enabled) return res.status(400).json({ error: 'This restaurant does not take orders for later.' });
  // ASAP orders need the place to be open right now; scheduled orders are checked against the slot's own hours below.
  if (!b.scheduledFor && !isOpenNow(er)) return res.status(409).json({ error: 'This restaurant is not accepting orders right now.' });
  if (b.scheduledFor && er.acceptingOrders === false) return res.status(409).json({ error: 'This restaurant is not accepting orders right now.' });

  if (b.idempotencyKey) {
    const dup = await Order.findOne({ restaurant: rest._id, idempotencyKey: b.idempotencyKey });
    if (dup) return res.json({ reference: dup.reference, trackingPath: null, duplicate: true });
  }
  const { items, unavailable, subtotal } = await priceCart(rest, b.cart, branchId);
  if (unavailable.length) return res.status(409).json({ error: 'Some items or options are no longer available. Please update your cart.', unavailable });

  // Fulfilment validation + delivery fee: radius formula on the server, from the restaurant's (or branch's) saved location (never from the browser)
  let deliveryFee = 0, deliveryPlace, deliveryDistanceKm, deliveryLocation;
  if (b.fulfillment === 'delivery') {
    if (!er.fulfillment.deliveryEnabled) return res.status(400).json({ error: 'Delivery is not offered' });
    if (!validPlaceId(b.deliveryPlaceId)) return res.status(400).json({ error: 'Please search for your address and pick it from the list.' });
    const q = await quoteDelivery(er, b.deliveryPlaceId);
    if (!q.ok) return res.status(400).json({ error: `Sorry, that address is outside our delivery range (${er.fulfillment.radius.maxRadiusKm} km). Please choose pickup instead.` });
    deliveryFee = q.fee; deliveryPlace = q.place.address; deliveryDistanceKm = q.distanceKm; deliveryLocation = { lat: q.place.lat, lng: q.place.lng };
    if (!b.deliveryAddress || b.deliveryAddress.trim().length < 3) return res.status(400).json({ error: 'Please add your house name or number and any landmark' });
  } else if (b.fulfillment === 'pickup' && !er.fulfillment.pickupEnabled) return res.status(400).json({ error: 'Pickup is not offered' });
  else if (b.fulfillment === 'dine_in' && !er.fulfillment.dineInEnabled) return res.status(400).json({ error: 'Dine-in is not offered' });

  // Payment method validation
  const cfg = await PaymentConfig.findOne({ restaurant: rest._id }).select('+bank.accountNumber onboardingStatus');
  if (b.paymentMethod === 'paystack' && !(rest.payments.paystackEnabled && cfg?.onboardingStatus === 'active')) return res.status(400).json({ error: 'Online payment is not available' });
  if (b.paymentMethod === 'bank_transfer' && !(rest.payments.bankTransferEnabled && cfg?.bank?.accountNumber)) return res.status(400).json({ error: 'Bank transfer is not available' });
  if (b.paymentMethod === 'pod' && !rest.payments.podEnabled) return res.status(400).json({ error: 'Pay on delivery is not available' });
  if (b.paymentMethod === 'pod' && b.fulfillment !== 'delivery') return res.status(400).json({ error: 'Pay on delivery applies to delivery orders only' });

  // Order for later: the slot must be one we would have offered (opening hours, notice, window, capacity), then a place is taken atomically.
  let scheduledAt = null, slotTaken = false;
  if (b.scheduledFor) {
    scheduledAt = new Date(b.scheduledFor);
    const tz = sch.timezone;
    const booked = await bookedCounts(rest._id, branchId, startOfLocalDay(scheduledAt, tz), addLocalDays(scheduledAt, 1, tz));
    if (!isValidSlot({ startISO: scheduledAt.toISOString(), hours: er.openingHours, cfg: sch, booked, acceptingOrders: er.acceptingOrders !== false }))
      return res.status(409).json({ error: 'That time is no longer available. Please choose another slot.', code: 'SLOT_UNAVAILABLE' });
    if (!(await reserveSlot(rest._id, branchId, scheduledAt, sch.capacityPerSlot))) return res.status(409).json({ error: 'That time slot just filled up. Please choose another.', code: 'SLOT_UNAVAILABLE' });
    slotTaken = true;
  }

  // Commission snapshot: the rate comes from the live plan config for this restaurant's CURRENT plan, applies to the meal subtotal only,
  // and only to payments that go through Ordarly's Paystack split. Nothing here is read from the request.
  const planCfg = await getPlanConfig();
  const commissionPct = b.paymentMethod === 'paystack' ? commissionPctFor(planCfg, plan) : 0;
  const commissionAmount = commissionOf(subtotal, commissionPct);

  const token = randomToken(24);
  const paymentStatus = { paystack: 'awaiting_payment', bank_transfer: 'awaiting_payment', pod: 'unpaid_pod' }[b.paymentMethod];
  let order;
  try {
    order = await Order.create({
      restaurant: rest._id, reference: orderRef(), channel: 'checkout', trackingTokenHash: sha256(token),
      branch: branchId, branchName: ctx.branch?.name, commissionPct, commissionAmount,
      isScheduled: !!scheduledAt, scheduledFor: scheduledAt || undefined,
      customerName: b.customerName, customerEmail: b.customerEmail, customerPhone: normalisePhone(b.customerPhone),
      items, subtotal, deliveryFee, total: subtotal + deliveryFee,
      fulfillment: b.fulfillment, deliveryPlace, deliveryDistanceKm, deliveryLocation, deliveryAddress: b.deliveryAddress, tableNumber: b.tableNumber,
      paymentMethod: b.paymentMethod, paymentStatus, status: 'pending', notes: b.notes, idempotencyKey: b.idempotencyKey,
    });
  } catch (e) {
    if (slotTaken) await releaseSlotRaw(rest._id, branchId, scheduledAt).catch(() => {}); // order never got created: give the place back
    throw e;
  }

  // Links back to the restaurant's own domain when the order came from it; otherwise the main Ordarly site.
  const trackUrl = `${await publicBaseFor(req, rest, isPro)}/track/${token}`;
  // Paystack: start the payment right now so the customer goes straight to the payment page (no extra page or tap).
  let paymentUrl;
  if (b.paymentMethod === 'paystack') {
    try { paymentUrl = (await startOrderPayment(order, rest, `${trackUrl}?pay=1`)).authorizationUrl; }
    catch (e) { console.error('[checkout] could not start payment', e.message); } // the tracking page still offers "Pay now"
  }
  const when = scheduledAt ? formatLocal(scheduledAt, tzOf(rest)) : null;
  const where = ctx.branch ? ` at ${ctx.branch.name}` : '';
  // Emails after save; failures never affect the order
  sendEmail({ to: b.customerEmail, type: 'order_confirmation', restaurant: rest._id, order: order._id, dedupeKey: `conf:${order._id}`,
    subject: `Order ${order.reference} received`,
    body: `<p>Thanks ${b.customerName}! Total: <b>${naira(order.total)}</b>${where}.${when ? ` Scheduled for <b>${when}</b>.` : ''}</p>${btn(trackUrl, 'Track your order')}` });
  // Orders that need money first are announced to the restaurant only once payment is confirmed or proof is uploaded.
  if (b.paymentMethod === 'pod') {
    sendEmail({ to: rest.email, type: 'new_order', restaurant: rest._id, order: order._id, dedupeKey: `new:${order._id}`,
      subject: `New ${when ? 'scheduled ' : ''}order ${order.reference}${ctx.branch ? ' · ' + ctx.branch.name : ''}`, body: `<p>${naira(order.total)} via ${b.fulfillment}${where}.${when ? ` <b>Scheduled for ${when}.</b> Do not prepare it yet.` : ''}</p>${btn(`${process.env.CLIENT_URL}/dashboard/orders`, 'Open orders')}` });
    notifyRestaurant(rest._id, { title: when ? 'New scheduled order' : 'New order', body: `${order.reference} · ${naira(order.total)}${where}${when ? ' · for ' + when : ''} (pay on delivery)`, url: '/dashboard/orders', tag: `order-${order._id}` });
  }

  res.status(201).json({
    reference: order.reference, total: order.total, subtotal, deliveryFee, trackingToken: token,
    paymentMethod: b.paymentMethod, paymentStatus, paymentUrl, scheduledFor: scheduledAt, scheduledLabel: when,
    next: b.paymentMethod === 'paystack' ? 'pay_online' : b.paymentMethod === 'bank_transfer' ? 'upload_proof' : 'done',
  });
}));

/* ---------- Tracking ---------- */
r.get('/track/:token', wrap(async (req, res) => {
  const order = await Order.findOne({ trackingTokenHash: sha256(req.params.token) }).lean();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const rest = await Restaurant.findById(order.restaurant).lean();
  const branch = order.branch ? await Branch.findById(order.branch).select('name address').lean() : null;
  res.json({
    reference: order.reference, restaurant: rest.name, restaurantSlug: rest.slug, branch: order.branchName || branch?.name || null,
    items: order.items.map(({ name, size, quantity, price, addons }) => ({ name, size, quantity, price, addons })),
    subtotal: order.subtotal, deliveryFee: order.deliveryFee, total: order.total, fulfillment: order.fulfillment,
    pickupAddress: order.fulfillment === 'pickup' ? (branch?.address || rest.address) : undefined,
    deliveryAddress: order.deliveryAddress ? `${order.deliveryAddress}${order.deliveryPlace ? ', ' + order.deliveryPlace : ''}` : undefined,
    status: order.status, paymentStatus: order.paymentStatus,
    isScheduled: !!order.isScheduled, scheduledFor: order.scheduledFor || null, scheduledLabel: order.scheduledFor ? formatLocal(order.scheduledFor, tzOf(rest)) : null,
    paymentMethod: order.paymentMethod, updatedAt: order.updatedAt,
  });
}));

export default r;
