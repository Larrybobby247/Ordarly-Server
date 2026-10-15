import { Router } from 'express';
import dns from 'dns/promises';
import { Restaurant, Category, Meal, PaymentConfig, Order } from '../models/index.js';
import { z, validate, wrap, normalisePhone, validWhatsapp, slugify, randomToken } from '../utils/helpers.js';
import { requireAuth, loadRestaurant, requirePro } from '../middleware/auth.js';
import { clearCacheOnWrite } from '../services/publicCache.js';
import { RESERVED_SLUGS, NIGERIAN_STATES } from '../config/plans.js';
import { startTrial } from '../services/subscription.js';
import { autocomplete, placeDetails, placesConfigured } from '../services/places.js';

const r = Router();
r.use(requireAuth, loadRestaurant);
r.use(clearCacheOnWrite); // PERF: owner edits clear the public-page cache so customers see changes immediately

const profileSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  description: z.string().max(500).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional(),
  whatsapp: z.string().optional(),
  address: z.string().max(400).optional(), placeId: z.string().max(2000).optional(), sessionToken: z.string().max(64).optional(),
  state: z.enum(NIGERIAN_STATES).optional(),
  logo: z.string().url().optional().or(z.literal('')),
  cover: z.string().url().optional().or(z.literal('')),
  acceptingOrders: z.boolean().optional(),
  openingHours: z.array(z.object({ day: z.number().min(0).max(6), open: z.string(), close: z.string(), closed: z.boolean().optional() })).optional(),
});

r.get('/', wrap(async (req, res) => {
  const origin = (process.env.CLIENT_URL || '').replace(/\/+$/, '');
  res.json({
    restaurant: req.restaurant, isPro: req.isPro, subscription: req.subscription,
    plan: { maxActiveMeals: req.isPro ? null : req.planConfig.free.maxActiveMeals, proPrice: req.planConfig.pro.priceNgn },
    publicUrl: req.restaurant.customDomainStatus === 'verified' && req.isPro
      ? `https://${req.restaurant.customDomain}` : `${origin}/${req.restaurant.slug}`,
  });
}));

r.patch('/', validate(profileSchema), wrap(async (req, res) => {
  const b = { ...req.body };
  if (b.whatsapp !== undefined) {
    b.whatsapp = normalisePhone(b.whatsapp);
    if (b.whatsapp && !validWhatsapp(b.whatsapp)) return res.status(400).json({ error: 'WhatsApp number must include the country code, e.g. 2348012345678' });
  }
  const { placeId, sessionToken } = b; delete b.placeId; delete b.sessionToken;
  Object.assign(req.restaurant, b); // schema whitelist: plan/status/owner cannot be set here
  if (placeId) { // an address picked from the suggestions also becomes the delivery start point
    try { const p = await placeDetails(placeId, sessionToken); req.restaurant.fulfillment.location = { placeId: p.placeId, address: p.address, lat: p.lat, lng: p.lng }; } catch { /* keep the typed address */ }
  }
  await req.restaurant.save();
  res.json({ restaurant: req.restaurant });
}));

r.patch('/slug', validate(z.object({ slug: z.string().min(3).max(40) })), wrap(async (req, res) => {
  const slug = slugify(req.body.slug);
  if (slug.length < 3 || RESERVED_SLUGS.has(slug)) return res.status(400).json({ error: 'That URL is not allowed' });
  if (await Restaurant.exists({ slug, _id: { $ne: req.restaurant._id } })) return res.status(409).json({ error: 'That URL is taken' });
  req.restaurant.slug = slug; await req.restaurant.save();
  res.json({ slug });
}));

r.post('/trial', wrap(async (req, res) => {
  const sub = await startTrial(req.restaurant._id);
  res.json({ subscription: sub });
}));

/* ---------- Custom domain (Pro) ---------- */
const DOMAIN_RE = /^(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,24}$/;
r.put('/custom-domain', requirePro('Custom domain'), validate(z.object({ domain: z.string().min(4).max(253) })), wrap(async (req, res) => {
  const domain = req.body.domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Enter a valid domain, e.g. order.myrestaurant.com' });
  if (domain === process.env.PLATFORM_DOMAIN || domain.endsWith('.' + process.env.PLATFORM_DOMAIN)) return res.status(400).json({ error: 'That domain is reserved' });
  if (await Restaurant.exists({ customDomain: domain, _id: { $ne: req.restaurant._id } })) return res.status(409).json({ error: 'Domain already in use' });
  req.restaurant.customDomain = domain;
  req.restaurant.customDomainStatus = 'pending_dns';
  req.restaurant.customDomainToken = randomToken(12);
  await req.restaurant.save();
  res.json(domainInstructions(req.restaurant));
}));

function domainInstructions(rest) {
  return {
    domain: rest.customDomain, status: rest.customDomainStatus,
    dns: [
      { type: 'CNAME', host: rest.customDomain, value: process.env.CUSTOM_DOMAIN_TARGET || process.env.PLATFORM_DOMAIN },
      { type: 'TXT', host: `_orderly-verify.${rest.customDomain}`, value: `orderly-verify=${rest.customDomainToken}` },
    ],
    note: 'DNS changes can take up to 48 hours. The domain also has to be added to your hosting provider so it can issue an SSL certificate.',
  };
}

r.get('/custom-domain', wrap(async (req, res) => {
  if (!req.restaurant.customDomain) return res.json({ domain: null });
  res.json(domainInstructions(req.restaurant));
}));

r.post('/custom-domain/verify', requirePro('Custom domain'), wrap(async (req, res) => {
  const rest = req.restaurant;
  if (!rest.customDomain) return res.status(400).json({ error: 'No domain set' });
  try {
    const txt = (await dns.resolveTxt(`_orderly-verify.${rest.customDomain}`)).flat();
    if (txt.includes(`orderly-verify=${rest.customDomainToken}`)) {
      rest.customDomainStatus = 'verified'; await rest.save();
      return res.json({ verified: true, ...domainInstructions(rest) });
    }
  } catch { /* fall through */ }
  res.json({ verified: false, ...domainInstructions(rest), error: 'TXT record not found yet. DNS may still be propagating.' });
}));

r.delete('/custom-domain', wrap(async (req, res) => {
  req.restaurant.customDomain = undefined; req.restaurant.customDomainStatus = 'none'; req.restaurant.customDomainToken = undefined;
  await req.restaurant.save(); res.json({ ok: true });
}));

/* ---------- Fulfillment & radius delivery pricing (Pro) ---------- */
const deliveryReady = (f) => !!(f.radius?.configured && f.location?.lat != null);

r.get('/fulfillment', wrap(async (req, res) => {
  const f = req.restaurant.fulfillment;
  res.json({ fulfillment: f, deliveryReady: deliveryReady(f), mapsConfigured: placesConfigured() });
}));

// Address search for the restaurant's own address (all plans). Goes through our server, so the Google key never reaches the browser.
r.post('/places/autocomplete', validate(z.object({ input: z.string().min(3).max(120), sessionToken: z.string().max(64).optional() })), wrap(async (req, res) => {
  res.json({ suggestions: await autocomplete(req.body.input, { sessionToken: req.body.sessionToken }) });
}));

const radiusSchema = z.object({
  placeId: z.string().max(2000).optional(),
  baseFee: z.number().min(0).max(100000), baseDistanceKm: z.number().min(0.5).max(50),
  perKmRate: z.number().min(0).max(100000), maxRadiusKm: z.number().min(1).max(100),
  sessionToken: z.string().max(64).optional(),
}).refine((v) => v.maxRadiusKm >= v.baseDistanceKm, { message: 'Maximum radius must be at least the base distance.', path: ['maxRadiusKm'] });

r.put('/delivery-radius', requirePro('Delivery pricing'), validate(radiusSchema), wrap(async (req, res) => {
  const f = req.restaurant.fulfillment; const b = req.body;
  if (b.placeId) {
    const p = await placeDetails(b.placeId, b.sessionToken);
    f.location = { placeId: p.placeId, address: p.address, lat: p.lat, lng: p.lng };
  }
  if (f.location?.lat == null) return res.status(400).json({ error: 'Search for and pick your restaurant\'s address first.' });
  f.radius = { baseFee: b.baseFee, baseDistanceKm: b.baseDistanceKm, perKmRate: b.perKmRate, maxRadiusKm: b.maxRadiusKm, configured: true };
  req.restaurant.markModified('fulfillment');
  await req.restaurant.save();
  res.json({ fulfillment: req.restaurant.fulfillment, deliveryReady: true });
}));

r.put('/fulfillment', requirePro('Fulfillment settings'), validate(z.object({
  deliveryEnabled: z.boolean(), pickupEnabled: z.boolean(), pickupInstructions: z.string().max(300).optional(),
  dineInEnabled: z.boolean(), askTableNumber: z.boolean().optional(),
})), wrap(async (req, res) => {
  if (req.body.deliveryEnabled && !deliveryReady(req.restaurant.fulfillment))
    return res.status(400).json({ error: 'Set up your radius delivery rate first (your location, base fee, per-km rate and maximum radius), then turn delivery on.' });
  Object.assign(req.restaurant.fulfillment, req.body); await req.restaurant.save();
  res.json({ fulfillment: req.restaurant.fulfillment });
}));

/* ---------- Payment settings (Pro) ---------- */
const mask = (n = '') => (n.length > 4 ? '••••••' + n.slice(-4) : '••••');

r.get('/payments', requirePro('Payment settings'), wrap(async (req, res) => {
  const cfg = await PaymentConfig.findOne({ restaurant: req.restaurant._id }).select('+bank.accountNumber');
  res.json({
    enabled: req.restaurant.payments,
    paystack: { status: cfg?.onboardingStatus || 'not_configured', subaccountCode: cfg?.subaccountCode ? 'set' : null, settlementAccount: cfg?.settlementAccountMasked },
    bank: cfg?.bank ? { bankName: cfg.bank.bankName, accountName: cfg.bank.accountName, accountNumber: mask(cfg.bank.accountNumber) } : null,
  });
}));

r.put('/payments/bank', requirePro('Bank transfer'), validate(z.object({
  bankName: z.string().min(2).max(80), accountName: z.string().min(2).max(100),
  accountNumber: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
  enabled: z.boolean(), acknowledged: z.literal(true, { errorMap: () => ({ message: 'Please acknowledge that bank transfers are not automatically verified' }) }),
})), wrap(async (req, res) => {
  const { bankName, accountName, accountNumber, enabled } = req.body;
  await PaymentConfig.updateOne({ restaurant: req.restaurant._id }, { bank: { bankName, accountName, accountNumber } }, { upsert: true });
  req.restaurant.payments.bankTransferEnabled = enabled; await req.restaurant.save();
  res.json({ ok: true });
}));

r.put('/payments/toggles', requirePro('Payment settings'), validate(z.object({ podEnabled: z.boolean().optional(), paystackEnabled: z.boolean().optional() })), wrap(async (req, res) => {
  if (req.body.paystackEnabled) {
    const cfg = await PaymentConfig.findOne({ restaurant: req.restaurant._id });
    if (cfg?.onboardingStatus !== 'active') return res.status(400).json({ error: 'Paystack setup is not active yet' });
  }
  Object.assign(req.restaurant.payments, req.body); await req.restaurant.save();
  res.json({ enabled: req.restaurant.payments });
}));

/* ---------- Analytics (counts real data only) ---------- */
r.get('/analytics', wrap(async (req, res) => {
  const rid = req.restaurant._id;
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  // PERF (changed): this used to run SIX separate count queries on every dashboard visit. One aggregation (grouped by status, using the
  // restaurant index) now returns all the same numbers, so the Overview page needs a single database round trip for its counts.
  const byStatus = await Order.aggregate([
    { $match: { restaurant: rid } },
    { $group: { _id: '$status', n: { $sum: 1 },
      today: { $sum: { $cond: [{ $gte: ['$createdAt', startOfDay] }, 1, 0] } },
      week: { $sum: { $cond: [{ $gte: ['$createdAt', weekAgo] }, 1, 0] } } } },
  ]);
  const sumOf = (field, statuses) => byStatus.filter((x) => !statuses || statuses.includes(x._id)).reduce((a, x) => a + x[field], 0);
  const total = sumOf('n'), today = sumOf('today'), week = sumOf('week');
  const awaiting = sumOf('n', ['awaiting_whatsapp', 'pending']), completed = sumOf('n', ['completed']), cancelled = sumOf('n', ['cancelled']);
  const out = { total, today, week, awaiting, completed, cancelled, isPro: req.isPro };
  if (req.isPro) {
    const sum = (match) => Order.aggregate([{ $match: { restaurant: rid, ...match } }, { $group: { _id: null, v: { $sum: '$total' }, n: { $sum: 1 } } }]);
    const [onlineCollected, manual, podOwed, popular, byFulfillment, byPayment] = await Promise.all([
      sum({ paymentStatus: 'paid', status: { $ne: 'cancelled' } }),
      sum({ paymentStatus: 'paid_manual', status: { $ne: 'cancelled' } }),
      sum({ paymentStatus: 'unpaid_pod', status: { $nin: ['cancelled'] } }),
      Order.aggregate([{ $match: { restaurant: rid, status: { $ne: 'cancelled' } } }, { $unwind: '$items' },
        { $group: { _id: '$items.name', qty: { $sum: '$items.quantity' } } }, { $sort: { qty: -1 } }, { $limit: 5 }]),
      Order.aggregate([{ $match: { restaurant: rid } }, { $group: { _id: '$fulfillment', n: { $sum: 1 } } }]),
      Order.aggregate([{ $match: { restaurant: rid } }, { $group: { _id: '$paymentMethod', n: { $sum: 1 } } }]),
    ]);
    Object.assign(out, {
      collectedOnline: onlineCollected[0]?.v || 0,
      manuallyVerified: manual[0]?.v || 0,
      podAwaitingCollection: podOwed[0]?.v || 0,
      popular, byFulfillment, byPayment,
    });
  }
  res.json(out);
}));

export default r;
