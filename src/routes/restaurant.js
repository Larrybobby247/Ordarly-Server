import { Router } from 'express';
import { Restaurant, Category, Meal, PaymentConfig, Order, Branch } from '../models/index.js';
import { z, validate, wrap, normalisePhone, validWhatsapp, slugify } from '../utils/helpers.js';
import { requireAuth, loadRestaurant, requirePro } from '../middleware/auth.js';
import { clearCacheOnWrite } from '../services/publicCache.js';
import { RESERVED_SLUGS, NIGERIAN_STATES } from '../config/plans.js';
import { restaurantUrl } from '../services/customDomain.js';
import { branchFilter, canBranch } from '../services/access.js';
import { DEFAULT_SCHEDULING, schedulingOf } from '../services/schedule.js';
import { validTz } from '../services/tz.js';
import mongoose from 'mongoose';
import { autocomplete, placeDetails, placesConfigured } from '../services/places.js';
import { registerDomain, checkNow, disconnectDomain, domainView, DomainError } from '../services/customDomain.js';
import { vercelConfigured } from '../services/vercel.js';

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
  const rest = req.restaurant;
  const common = { isPro: req.isPro, planKey: req.plan, isBusiness: req.isBusiness };
  // Branch names the caller may work with (everything for owners / all-branch managers, otherwise just their own), for filters and pickers.
  const branches = req.isBusiness ? await Branch.find({ restaurant: rest._id, ...branchFilter(req.access, '_id') }).select('name status').sort('sort name').lean() : [];
  const access = { isOwner: req.access.isOwner, role: req.access.role, allBranches: req.access.allBranches, branchIds: req.access.branchIds, perms: [...req.access.perms] };
  if (!req.access.isOwner) { // staff only get what the dashboard layout needs
    return res.json({ restaurant: { _id: rest._id, name: rest.name, slug: rest.slug, plan: rest.plan, logo: rest.logo }, ...common, access, branches });
  }
  const customDomainActive = !!rest.customDomain && req.isPro && (rest.customDomainStatus === 'active' || (rest.customDomainStatus === 'verified' && rest.customDomainMeta?.legacy));
  const cfg = req.planConfig;
  res.json({
    restaurant: rest, ...common, access, branches, subscription: req.subscription,
    plan: { maxActiveMeals: req.isPro ? null : cfg.free.maxActiveMeals, proPrice: cfg.pro.priceNgn, commissionPct: cfg[req.plan]?.commissionPct ?? 0, maxBranches: req.isBusiness ? cfg.business.maxBranches : 0 },
    publicUrl: restaurantUrl(rest, { customDomainActive }),
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
  if (slug.length < 3 || RESERVED_SLUGS.has(slug) || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) return res.status(400).json({ error: 'That URL is not allowed. Use letters, numbers and hyphens (not at the start or end).' });
  if (await Restaurant.exists({ slug, _id: { $ne: req.restaurant._id } })) return res.status(409).json({ error: 'That URL is taken' });
  req.restaurant.slug = slug; await req.restaurant.save();
  res.json({ slug });
}));

// The 14-day Pro trial has been retired (Free now includes online ordering). Kept as an explicit "gone" so old app versions get a clear answer.
r.post('/trial', (req, res) => res.status(410).json({ error: 'The free trial is no longer offered. The Free plan already includes online ordering.', code: 'TRIAL_RETIRED' }));

/* ---------- Custom domain (Pro) ----------
 * Logic lives in services/customDomain.js (state machine) + services/vercel.js (Vercel REST API). Routes stay thin:
 * the restaurant is always the CALLER'S OWN (loadRestaurant), so one owner can never touch another tenant's domain. */
const domainRoute = (fn) => wrap(async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e instanceof DomainError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

r.put('/custom-domain', requirePro('Custom domain'), validate(z.object({ domain: z.string().min(3).max(300) })), domainRoute(async (req, res) => {
  res.json(await registerDomain(req.restaurant, req.body.domain));
}));

// Readable even after a downgrade so the owner can still see and remove the domain.
r.get('/custom-domain', wrap(async (req, res) => {
  res.json({ ...domainView(req.restaurant), available: vercelConfigured() });
}));

r.post('/custom-domain/verify', requirePro('Custom domain'), domainRoute(async (req, res) => {
  if (!req.restaurant.customDomain) throw new DomainError('No domain set', 400);
  res.json(await checkNow(req.restaurant));
}));

r.delete('/custom-domain', domainRoute(async (req, res) => {
  await disconnectDomain(req.restaurant);
  res.json({ ok: true, ...domainView(await Restaurant.findById(req.restaurant._id)) });
}));

/* ---------- Fulfillment & radius delivery pricing (all plans) ---------- */
const deliveryReady = (f) => !!(f.radius?.configured && f.location?.lat != null);

r.get('/fulfillment', wrap(async (req, res) => {
  const f = req.restaurant.fulfillment;
  res.json({ fulfillment: f, deliveryReady: deliveryReady(f), mapsConfigured: placesConfigured() });
}));

// Address search for the restaurant's own address (all plans). Goes through our server, so the LocationIQ key never reaches the browser.
r.post('/places/autocomplete', validate(z.object({ input: z.string().min(3).max(120), sessionToken: z.string().max(64).optional() })), wrap(async (req, res) => {
  res.json({ suggestions: await autocomplete(req.body.input, { sessionToken: req.body.sessionToken }) });
}));

const radiusSchema = z.object({
  placeId: z.string().max(2000).optional(),
  baseFee: z.number().min(0).max(100000), baseDistanceKm: z.number().min(0.5).max(50),
  perKmRate: z.number().min(0).max(100000), maxRadiusKm: z.number().min(1).max(100),
  sessionToken: z.string().max(64).optional(),
}).refine((v) => v.maxRadiusKm >= v.baseDistanceKm, { message: 'Maximum radius must be at least the base distance.', path: ['maxRadiusKm'] });

r.put('/delivery-radius', validate(radiusSchema), wrap(async (req, res) => {
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

r.put('/fulfillment', validate(z.object({
  deliveryEnabled: z.boolean(), pickupEnabled: z.boolean(), pickupInstructions: z.string().max(300).optional(),
  dineInEnabled: z.boolean(), askTableNumber: z.boolean().optional(),
})), wrap(async (req, res) => {
  if (req.body.deliveryEnabled && !deliveryReady(req.restaurant.fulfillment))
    return res.status(400).json({ error: 'Set up your radius delivery rate first (your location, base fee, per-km rate and maximum radius), then turn delivery on.' });
  Object.assign(req.restaurant.fulfillment, req.body); await req.restaurant.save();
  res.json({ fulfillment: req.restaurant.fulfillment });
}));

/* ---------- Payment settings (online payment: all plans; bank transfer and pay on delivery: Pro) ---------- */
const mask = (n = '') => (n.length > 4 ? '••••••' + n.slice(-4) : '••••');

r.get('/payments', wrap(async (req, res) => {
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

r.put('/payments/toggles', validate(z.object({ podEnabled: z.boolean().optional(), paystackEnabled: z.boolean().optional() })), wrap(async (req, res) => {
  // Free restaurants take online payments only. Pay on delivery is a Pro feature (enforced here, not just hidden in the UI).
  if (req.body.podEnabled && !req.isPro) return res.status(402).json({ error: 'Pay on delivery requires the Pro plan', code: 'PRO_REQUIRED' });
  if (req.body.paystackEnabled) {
    const cfg = await PaymentConfig.findOne({ restaurant: req.restaurant._id });
    if (cfg?.onboardingStatus !== 'active') return res.status(400).json({ error: 'Paystack setup is not active yet' });
  }
  Object.assign(req.restaurant.payments, req.body); await req.restaurant.save();
  res.json({ enabled: req.restaurant.payments });
}));

/* ---------- Order-for-later settings (owner only: not reachable by staff) ---------- */
const schedulingSchema = z.object({
  enabled: z.boolean(), maxDaysAhead: z.number().int().min(1).max(60), minNoticeMinutes: z.number().int().min(0).max(7 * 24 * 60),
  slotMinutes: z.number().int().min(10).max(240), capacityPerSlot: z.number().int().min(0).max(500), reminderMinutes: z.number().int().min(5).max(180),
  timezone: z.string().max(60).optional(),
});
r.get('/scheduling', wrap(async (req, res) => res.json({ scheduling: schedulingOf(req.restaurant), defaults: DEFAULT_SCHEDULING })));
r.put('/scheduling', validate(schedulingSchema), wrap(async (req, res) => {
  const b = { ...req.body };
  if (b.timezone && !validTz(b.timezone)) return res.status(400).json({ error: 'Unknown time zone.' });
  if (!b.timezone) b.timezone = schedulingOf(req.restaurant).timezone;
  req.restaurant.scheduling = b; await req.restaurant.save();
  res.json({ scheduling: schedulingOf(req.restaurant) });
}));

/* ---------- Analytics (counts real data only; available on every plan) ---------- */
r.get('/analytics', wrap(async (req, res) => {
  const rid = req.restaurant._id;
  // Staff only ever see the branches they were given; owners can narrow to one branch with ?branch=.
  const scope = { restaurant: rid, ...branchFilter(req.access) };
  const only = req.query.branch;
  if (only) { if (!mongoose.isValidObjectId(only) || !canBranch(req.access, only)) return res.status(403).json({ error: 'You do not have access to that branch.' }); scope.branch = new mongoose.Types.ObjectId(only); }
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  // One aggregation (grouped by status) returns all the counts, so the Overview page needs a single database round trip for them.
  const byStatus = await Order.aggregate([
    { $match: scope },
    { $group: { _id: '$status', n: { $sum: 1 },
      today: { $sum: { $cond: [{ $gte: ['$createdAt', startOfDay] }, 1, 0] } },
      week: { $sum: { $cond: [{ $gte: ['$createdAt', weekAgo] }, 1, 0] } } } },
  ]);
  const sumOf = (field, statuses) => byStatus.filter((x) => !statuses || statuses.includes(x._id)).reduce((a, x) => a + x[field], 0);
  const total = sumOf('n'), today = sumOf('today'), week = sumOf('week');
  const awaiting = sumOf('n', ['awaiting_whatsapp', 'pending']), completed = sumOf('n', ['completed']), cancelled = sumOf('n', ['cancelled']);
  const out = { total, today, week, awaiting, completed, cancelled, isPro: req.isPro };
  const sum = (match) => Order.aggregate([{ $match: { ...scope, ...match } }, { $group: { _id: null, v: { $sum: '$total' }, n: { $sum: 1 } } }]);
  const [onlineCollected, manual, podOwed, popular, byFulfillment, byPayment, upcoming] = await Promise.all([
    sum({ paymentStatus: 'paid', status: { $ne: 'cancelled' } }),
    sum({ paymentStatus: 'paid_manual', status: { $ne: 'cancelled' } }),
    sum({ paymentStatus: 'unpaid_pod', status: { $nin: ['cancelled'] } }),
    Order.aggregate([{ $match: { ...scope, status: { $ne: 'cancelled' } } }, { $unwind: '$items' },
      { $group: { _id: '$items.name', qty: { $sum: '$items.quantity' } } }, { $sort: { qty: -1 } }, { $limit: 5 }]),
    Order.aggregate([{ $match: scope }, { $group: { _id: '$fulfillment', n: { $sum: 1 } } }]),
    Order.aggregate([{ $match: scope }, { $group: { _id: '$paymentMethod', n: { $sum: 1 } } }]),
    Order.countDocuments({ ...scope, isScheduled: true, status: { $nin: ['completed', 'cancelled'] } }),
  ]);
  Object.assign(out, {
    collectedOnline: onlineCollected[0]?.v || 0,
    manuallyVerified: manual[0]?.v || 0,
    podAwaitingCollection: podOwed[0]?.v || 0,
    upcomingScheduled: upcoming,
    popular, byFulfillment, byPayment,
  });
  res.json(out);
}));

export default r;
