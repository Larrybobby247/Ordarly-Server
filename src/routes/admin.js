import { Router } from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import {
  Restaurant, User, Subscription, SubscriptionPayment, Order, OrderPayment, PaymentConfig, EmailLog, AuditLog,
  ErrorLog, Complaint, Meal,
} from '../models/index.js';
import { z, validate, wrap, sha256, randomToken, escapeHtml } from '../utils/helpers.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getPlanConfig, setPlanConfig, getPlatformSettings, setPlatformSettings } from '../services/settings.js';
import { adminGrantPro, adminRevokePro } from '../services/subscription.js';
import { sendEmail, btn, retryEmailById } from '../services/email.js';
import { ps } from '../services/paystack.js';

const r = Router();
r.use(requireAuth, requireRole('admin'));
// Any :id that is not a valid ObjectId is simply "not found" instead of a 500.
r.param('id', (req, res, next, id) => (mongoose.isValidObjectId(id) ? next() : res.status(404).json({ error: 'Not found' })));

/* ---------- System check: is this deployment wired up correctly? (admin only; never returns secrets) ---------- */
r.get('/system-check', wrap(async (req, res) => {
  const key = process.env.PAYSTACK_SECRET_KEY || '';
  const mode = !key ? 'missing' : key.startsWith('sk_live_') ? 'live' : key.startsWith('sk_test_') ? 'test' : 'unknown';
  const paystack = { mode, reachable: false, message: '' };
  if (key) { try { await ps('/bank?country=nigeria&perPage=1'); paystack.reachable = true; } catch (e) { paystack.message = e.message; } }

  // Subaccounts made with a TEST key do not exist under a LIVE key. Spot-check a few connected restaurants.
  const sample = await PaymentConfig.find({ onboardingStatus: 'active', subaccountCode: { $exists: true } }).select('subaccountCode').limit(5).lean();
  let subaccounts = { checked: 0, notFound: 0 };
  if (key && paystack.reachable) {
    const results = await Promise.all(sample.map((c) => ps(`/subaccount/${encodeURIComponent(c.subaccountCode)}`).then(() => true).catch(() => false)));
    subaccounts = { checked: results.length, notFound: results.filter((x) => !x).length };
  }
  res.json({
    nodeEnv: process.env.NODE_ENV || '(not set)',
    database: mongoose.connection.readyState === 1,
    clientUrl: process.env.CLIENT_URL || null,
    requestHost: req.get('host'),
    webhookUrl: `https://${req.get('host')}/api/webhooks/paystack`,
    paystack, subaccounts,
    configured: {
      jwtSecret: !!process.env.JWT_SECRET, email: !!process.env.RESEND_API_KEY, addressSearch: !!process.env.LOCATIONIQ_API_KEY,
      pushNotifications: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
    },
  });
}));

const audit = (req, action, target, detail) =>
  AuditLog.create({ actor: req.user._id, action, target: String(target), detail }).catch(() => {});
const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const pg = (req, size = 20) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  return { page, size, skip: (page - 1) * size };
};
const range = (q) => (q.from || q.to
  ? { ...(q.from && { $gte: new Date(q.from) }), ...(q.to && { $lte: new Date(new Date(q.to).getTime() + 86399999) }) }
  : undefined);
const lagosDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

/* ================= Overview ================= */
r.get('/stats', wrap(async (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const in7 = new Date(+now + 7 * 86400000), ago24 = new Date(+now - 86400000), ago7 = new Date(+now - 7 * 86400000);
  const revenue = (m = {}) => SubscriptionPayment.aggregate([{ $match: { status: 'success', ...m } }, { $group: { _id: null, v: { $sum: '$amount' } } }]);
  const [
    restaurants, activeRestaurants, suspendedRestaurants, users, newUsers7, proSubscribers, activeTrials, expiredSubs,
    orders, ordersToday, revTotal, revMonth, failedEmails, openComplaints, failedSub, failedFood, expiringSoon,
  ] = await Promise.all([
    Restaurant.countDocuments(), Restaurant.countDocuments({ status: 'active' }), Restaurant.countDocuments({ status: 'suspended' }),
    User.countDocuments({ role: 'owner' }), User.countDocuments({ role: 'owner', createdAt: { $gte: ago7 } }),
    Subscription.countDocuments({ status: 'active' }), Subscription.countDocuments({ status: 'trialing' }), Subscription.countDocuments({ status: 'expired' }),
    Order.countDocuments(), Order.countDocuments({ createdAt: { $gte: startOfDay } }),
    revenue(), revenue({ createdAt: { $gte: startOfMonth } }),
    EmailLog.countDocuments({ status: 'failed' }), Complaint.countDocuments({ status: { $in: ['open', 'reviewed', 'in_review'] } }),
    SubscriptionPayment.countDocuments({ status: 'failed', updatedAt: { $gte: ago24 } }),
    OrderPayment.countDocuments({ status: 'failed', updatedAt: { $gte: ago24 } }),
    Subscription.countDocuments({ $or: [
      { status: 'trialing', trialEnd: { $gt: now, $lte: in7 } }, { status: 'active', periodEnd: { $gt: now, $lte: in7 } },
    ] }),
  ]);
  res.json({
    restaurants, activeRestaurants, suspendedRestaurants, users, newUsers7, proSubscribers, activeTrials, expiredSubs,
    orders, ordersToday, subscriptionRevenue: revTotal[0]?.v || 0, subscriptionRevenueMonth: revMonth[0]?.v || 0,
    failedEmails, openComplaints, failedPayments24h: failedSub + failedFood, expiringSoon,
  });
}));

/* ================= Users ================= */
r.get('/users', wrap(async (req, res) => {
  const { q, role, status, plan, subStatus } = req.query; const { page, size, skip } = pg(req);
  const early = {};
  if (role) early.role = String(role);
  if (status) early.status = String(status);
  const late = {};
  if (q) { const e = rx(q); late.$or = [{ name: e }, { email: e }, { phone: e }, { 'restaurant.name': e }]; }
  if (plan) late['restaurant.plan'] = String(plan);
  if (subStatus) late['sub.status'] = String(subStatus);

  const [out] = await User.aggregate([
    { $match: early },
    { $lookup: { from: 'restaurants', localField: '_id', foreignField: 'owner', as: 'rest' } },
    { $addFields: { restaurant: { $first: '$rest' } } },
    { $lookup: { from: 'subscriptions', localField: 'restaurant._id', foreignField: 'restaurant', as: 'subs' } },
    { $addFields: { sub: { $first: '$subs' } } },
    { $match: late },
    { $facet: {
      rows: [
        { $sort: { createdAt: -1 } }, { $skip: skip }, { $limit: size },
        // Whitelist projection: password hashes and tokens can never leak through an aggregation.
        { $project: {
          name: 1, email: 1, phone: 1, role: 1, status: 1, emailVerified: 1, createdAt: 1, lastLoginAt: 1,
          'restaurant._id': 1, 'restaurant.name': 1, 'restaurant.slug': 1, 'restaurant.plan': 1, 'restaurant.status': 1, 'restaurant.state': 1,
          'sub.status': 1, 'sub.trialEnd': 1, 'sub.periodEnd': 1,
        } },
      ],
      total: [{ $count: 'n' }],
    } },
  ]);
  const total = out.total[0]?.n || 0;
  res.json({ rows: out.rows, total, page, pages: Math.ceil(total / size) });
}));

r.get('/users/:id', wrap(async (req, res) => {
  const u = await User.findById(req.params.id).lean();
  if (!u) return res.status(404).json({ error: 'Not found' });
  const restaurant = await Restaurant.findOne({ owner: u._id }).select('-customDomainToken').lean();
  const rid = restaurant?._id;
  const [subscription, orderCount, lastOrder, mealCount, payCfg, complaints, emails, audits] = await Promise.all([
    rid ? Subscription.findOne({ restaurant: rid }).lean() : null,
    rid ? Order.countDocuments({ restaurant: rid }) : 0,
    rid ? Order.findOne({ restaurant: rid }).sort('-createdAt').select('createdAt reference').lean() : null,
    rid ? Meal.countDocuments({ restaurant: rid }) : 0,
    rid ? PaymentConfig.findOne({ restaurant: rid }).select('onboardingStatus provider').lean() : null, // status only: no bank data
    Complaint.find({ email: u.email }).select('reference subject status kind createdAt').sort('-createdAt').limit(10).lean(),
    EmailLog.find({ to: u.email }).select('type status lastError createdAt').sort('-createdAt').limit(10).lean(),
    AuditLog.find({ target: String(u._id) }).populate('actor', 'name email').sort('-createdAt').limit(10).lean(),
  ]);
  res.json({
    user: {
      _id: u._id, name: u.name, email: u.email, phone: u.phone, role: u.role, status: u.status, suspendReason: u.suspendReason,
      emailVerified: u.emailVerified, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
    },
    restaurant, subscription,
    stats: { orders: orderCount, meals: mealCount, lastOrder },
    paystackStatus: payCfg?.onboardingStatus || 'not_configured',
    complaints, emails, audits,
  });
}));

r.post('/users/:id/suspend', validate(z.object({ reason: z.string().min(3).max(300), suspendRestaurant: z.boolean().default(true) })), wrap(async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (String(u._id) === String(req.user._id)) return res.status(400).json({ error: 'You cannot suspend your own account.' });
  if (u.role === 'admin' && (await User.countDocuments({ role: 'admin', status: 'active', _id: { $ne: u._id } })) < 1)
    return res.status(400).json({ error: 'You cannot suspend the last active admin.' });
  u.status = 'suspended'; u.suspendReason = req.body.reason; await u.save();
  if (req.body.suspendRestaurant) await Restaurant.updateMany({ owner: u._id }, { status: 'suspended', suspendReason: req.body.reason });
  await audit(req, 'suspend_user', u._id, { reason: req.body.reason, restaurant: req.body.suspendRestaurant });
  sendEmail({ to: u.email, type: 'account_suspended', dedupeKey: `susp:${u._id}:${Date.now()}`, subject: 'Your Ordarly account has been suspended',
    body: `<p>Your account was suspended.</p><p><b>Reason:</b> ${escapeHtml(req.body.reason)}</p><p>If you think this is a mistake, reply to our support team.</p>` });
  res.json({ ok: true });
}));

r.post('/users/:id/reactivate', wrap(async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  u.status = 'active'; u.suspendReason = undefined; await u.save();
  await Restaurant.updateMany({ owner: u._id }, { status: 'active', $unset: { suspendReason: 1 } });
  await audit(req, 'reactivate_user', u._id);
  sendEmail({ to: u.email, type: 'account_reactivated', dedupeKey: `react:${u._id}:${Date.now()}`, subject: 'Your Ordarly account is active again',
    body: '<p>Your account has been reactivated. You can sign in again.</p>' });
  res.json({ ok: true });
}));

r.post('/users/:id/verify-email', wrap(async (req, res) => {
  const u = await User.findByIdAndUpdate(req.params.id, { emailVerified: true, $unset: { verifyTokenHash: 1 } });
  if (!u) return res.status(404).json({ error: 'Not found' });
  await audit(req, 'manually_verify_email', u._id);
  res.json({ ok: true });
}));

r.post('/users/:id/resend-verification', wrap(async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (u.emailVerified) return res.status(400).json({ error: 'This email is already verified.' });
  const token = randomToken();
  u.verifyTokenHash = sha256(token); await u.save();
  const log = await sendEmail({ to: u.email, type: 'verify_email', subject: 'Verify your email',
    body: `<p>Confirm your email to start taking orders.</p>${btn(`${process.env.CLIENT_URL}/verify-email?token=${token}`, 'Verify email')}` });
  await audit(req, 'resend_verification', u._id);
  res.json({ ok: true, email: log?.status || 'not_sent' });
}));

// Creating another admin: requires the acting admin's own password and is audited.
r.post('/users', validate(z.object({
  name: z.string().min(2).max(80), email: z.string().email(), password: z.string().min(10).max(100), yourPassword: z.string().min(1),
})), wrap(async (req, res) => {
  const me = await User.findById(req.user._id).select('+passwordHash');
  if (!(await bcrypt.compare(req.body.yourPassword, me.passwordHash))) return res.status(403).json({ error: 'Your password is incorrect.' });
  if (await User.exists({ email: req.body.email.toLowerCase() })) return res.status(409).json({ error: 'That email is already registered.' });
  const u = await User.create({
    name: req.body.name, email: req.body.email, passwordHash: await bcrypt.hash(req.body.password, 12), role: 'admin', emailVerified: true,
  });
  await audit(req, 'create_admin', u._id, { email: u.email });
  res.status(201).json({ id: u._id });
}));

/* ================= Restaurants ================= */
r.get('/restaurants', wrap(async (req, res) => {
  const { q, plan, status, state } = req.query; const { page, size, skip } = pg(req);
  const f = {};
  if (q) { const e = rx(q); f.$or = [{ name: e }, { slug: e }, { email: e }]; }
  if (plan) f.plan = String(plan);
  if (status) f.status = String(status);
  if (state) f.state = String(state);
  const [rows, total] = await Promise.all([
    Restaurant.find(f).select('name slug plan status state email createdAt owner customDomain customDomainStatus').populate('owner', 'name email').sort('-createdAt').skip(skip).limit(size).lean(),
    Restaurant.countDocuments(f),
  ]);
  const subs = await Subscription.find({ restaurant: { $in: rows.map((x) => x._id) } }).select('restaurant status trialEnd periodEnd').lean();
  const m = new Map(subs.map((s) => [String(s.restaurant), s]));
  res.json({ rows: rows.map((x) => ({ ...x, subscription: m.get(String(x._id)) || null })), total, page, pages: Math.ceil(total / size) });
}));

r.get('/restaurants/:id', wrap(async (req, res) => {
  const rest = await Restaurant.findById(req.params.id).select('-customDomainToken').populate('owner', 'name email phone status').lean();
  if (!rest) return res.status(404).json({ error: 'Not found' });
  const rid = rest._id;
  const agg = (match) => Order.aggregate([{ $match: { restaurant: rid, ...match } }, { $group: { _id: null, n: { $sum: 1 }, v: { $sum: '$total' } } }]);
  const [subscription, meals, all, completed, cancelled, tiers, payCfg, recent] = await Promise.all([
    Subscription.findOne({ restaurant: rid }).lean(), Meal.countDocuments({ restaurant: rid }),
    agg({}), agg({ status: 'completed' }), agg({ status: 'cancelled' }), Promise.resolve(0),
    PaymentConfig.findOne({ restaurant: rid }).select('onboardingStatus').lean(),
    Order.find({ restaurant: rid }).sort('-createdAt').limit(8).select('reference total status paymentStatus channel createdAt').lean(),
  ]);
  res.json({
    restaurant: rest, subscription,
    stats: {
      meals, orders: all[0]?.n || 0, orderValue: all[0]?.v || 0, completed: completed[0]?.n || 0, cancelled: cancelled[0]?.n || 0, deliveryConfigured: !!rest.fulfillment?.radius?.configured,
    },
    paystackStatus: payCfg?.onboardingStatus || 'not_configured', recentOrders: recent,
  });
}));

r.post('/restaurants/:id/suspend', validate(z.object({ reason: z.string().min(3).max(300) })), wrap(async (req, res) => {
  const rest = await Restaurant.findByIdAndUpdate(req.params.id, { status: 'suspended', suspendReason: req.body.reason }, { new: true });
  if (!rest) return res.status(404).json({ error: 'Not found' });
  await audit(req, 'suspend_restaurant', rest._id, { reason: req.body.reason });
  res.json({ ok: true });
}));
r.post('/restaurants/:id/reactivate', wrap(async (req, res) => {
  const rest = await Restaurant.findByIdAndUpdate(req.params.id, { status: 'active', $unset: { suspendReason: 1 } }, { new: true });
  if (!rest) return res.status(404).json({ error: 'Not found' });
  await audit(req, 'reactivate_restaurant', rest._id);
  res.json({ ok: true });
}));

// Manual comp / revoke of Pro (support goodwill, billing fixes). No payment record is created and it is audited.
r.post('/restaurants/:id/plan', validate(z.object({
  action: z.enum(['grant_pro', 'revoke_pro']), days: z.number().int().min(1).max(365).optional(), reason: z.string().min(3).max(300),
})), wrap(async (req, res) => {
  const rest = await Restaurant.findById(req.params.id);
  if (!rest) return res.status(404).json({ error: 'Not found' });
  if (req.body.action === 'grant_pro') {
    if (!req.body.days) return res.status(400).json({ error: 'Choose how many days to grant.' });
    await adminGrantPro(rest._id, req.body.days);
  } else await adminRevokePro(rest._id);
  await audit(req, req.body.action, rest._id, { days: req.body.days, reason: req.body.reason });
  res.json({ subscription: await Subscription.findOne({ restaurant: rest._id }).lean() });
}));

/* ================= Subscriptions ================= */
r.get('/subscriptions', wrap(async (req, res) => {
  const { q, status, expiringDays } = req.query; const { page, size, skip } = pg(req);
  const f = {};
  if (status) f.status = String(status);
  if (expiringDays) {
    const now = new Date(), lim = new Date(+now + Number(expiringDays) * 86400000);
    f.$or = [{ status: 'trialing', trialEnd: { $gt: now, $lte: lim } }, { status: 'active', periodEnd: { $gt: now, $lte: lim } }];
  }
  if (q) { const ids = await Restaurant.find({ name: rx(q) }).select('_id').limit(200); f.restaurant = { $in: ids.map((x) => x._id) }; }
  const [rows, total, counts] = await Promise.all([
    Subscription.find(f).populate('restaurant', 'name slug plan status').sort('-updatedAt').skip(skip).limit(size).lean(),
    Subscription.countDocuments(f),
    Subscription.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  res.json({ rows, total, page, pages: Math.ceil(total / size), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
}));

/* ================= Transactions ================= */
// Platform subscription payments and restaurants' Paystack food payments are shown separately on purpose:
// food-order money belongs to the restaurants; only subscription payments are platform revenue.
r.get('/transactions', wrap(async (req, res) => {
  const type = req.query.type === 'food' ? 'food' : 'subscription'; const { page, size, skip } = pg(req);
  const { q, status } = req.query; const created = range(req.query);
  const f = {};
  if (status) f.status = String(status);
  if (created) f.createdAt = created;
  if (q) {
    const ids = await Restaurant.find({ name: rx(q) }).select('_id').limit(200);
    f.$or = [{ providerReference: rx(q) }, { restaurant: { $in: ids.map((x) => x._id) } }];
  }
  const Model = type === 'food' ? OrderPayment : SubscriptionPayment;
  let query = Model.find(f).populate('restaurant', 'name slug').sort('-createdAt').skip(skip).limit(size);
  if (type === 'food') query = query.populate('order', 'reference total paymentMethod').select('-raw');
  const [rows, total, sums] = await Promise.all([
    query.lean(), Model.countDocuments(f),
    Model.aggregate([{ $group: { _id: '$status', n: { $sum: 1 }, v: { $sum: '$amount' } } }]),
  ]);
  const by = Object.fromEntries(sums.map((s) => [s._id, { count: s.n, amount: s.v }]));
  res.json({ type, rows, total, page, pages: Math.ceil(total / size), summary: by });
}));

// Full detail for one payment (admin support/dispute checks). Gateway payloads ("raw") are never returned.
r.get('/transactions/:type/:id', wrap(async (req, res) => {
  const food = req.params.type === 'food';
  if (!food && req.params.type !== 'subscription') return res.status(404).json({ error: 'Not found' });
  const Model = food ? OrderPayment : SubscriptionPayment;
  let q = Model.findById(req.params.id).select('-raw').populate({ path: 'restaurant', select: 'name slug email phone state status plan owner', populate: { path: 'owner', select: 'name email' } });
  if (food) q = q.populate('order', 'reference total subtotal deliveryFee status paymentStatus paymentMethod fulfillment customerName createdAt');
  const t = await q.lean();
  if (!t) return res.status(404).json({ error: 'Not found' });
  const sub = !food && t.subscription ? await Subscription.findById(t.subscription).select('status trialEnd periodEnd').lean() : null;
  res.json({ type: food ? 'food' : 'subscription', transaction: t, subscription: sub });
}));

/* ================= Complaints & reviews ================= */
r.get('/complaints', wrap(async (req, res) => {
  const { q, status, kind, priority, source } = req.query; const { page, size, skip } = pg(req);
  const f = {};
  if (source) f.source = String(source);
  if (status === 'active') f.status = { $in: ['open', 'reviewed', 'in_review'] }; else if (status) f.status = String(status);
  if (kind) f.kind = String(kind);
  if (priority) f.priority = String(priority);
  if (q) { const e = rx(q); f.$or = [{ reference: e }, { name: e }, { email: e }, { subject: e }, { message: e }, { orderRef: e }]; }
  const [rows, total, counts] = await Promise.all([
    Complaint.find(f).populate('restaurant', 'name slug').select('-notes -replies').sort('-createdAt').skip(skip).limit(size).lean(),
    Complaint.countDocuments(f),
    Complaint.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  res.json({ rows, total, page, pages: Math.ceil(total / size), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
}));

r.get('/complaints/:id', wrap(async (req, res) => {
  const c = await Complaint.findById(req.params.id).populate('restaurant', 'name slug').lean();
  c ? res.json(c) : res.status(404).json({ error: 'Not found' });
}));

r.patch('/complaints/:id', validate(z.object({
  status: z.enum(['open', 'reviewed', 'in_review', 'resolved', 'dismissed']).optional(), priority: z.enum(['low', 'normal', 'high']).optional(),
  note: z.string().min(1).max(1000).optional(),
})), wrap(async (req, res) => {
  const c = await Complaint.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const before = { status: c.status, priority: c.priority };
  if (req.body.status) c.status = req.body.status;
  if (req.body.priority) c.priority = req.body.priority;
  if (req.body.note) c.notes.push({ by: req.user.name, at: new Date(), text: req.body.note });
  await c.save();
  await audit(req, 'update_complaint', c._id, { before, after: { status: c.status, priority: c.priority }, noted: !!req.body.note });
  res.json(c);
}));

r.post('/complaints/:id/reply', validate(z.object({ message: z.string().min(2).max(2000) })), wrap(async (req, res) => {
  const c = await Complaint.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  c.replies.push({ by: req.user.name, at: new Date(), message: req.body.message });
  if (['open', 'reviewed'].includes(c.status)) c.status = 'in_review';
  await c.save();
  const log = await sendEmail({
    to: c.email, type: 'complaint_reply', dedupeKey: `cmp-reply:${c._id}:${c.replies.length}`,
    subject: `Re: ${c.subject || 'your message'} (${c.reference})`,
    body: `<p>${escapeHtml(req.body.message).replace(/\n/g, '<br>')}</p><p style="color:#64748b;font-size:12px">Reference ${c.reference}</p>`,
  });
  await audit(req, 'reply_complaint', c._id);
  // "accepted" only means the email provider took it; it is not proof of inbox delivery.
  res.json({ complaint: c, email: log?.status || 'not_sent' });
}));

/* ================= Analytics ================= */
function fillDays(days, rows) {
  const map = new Map(rows.map((x) => [x._id, x]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = lagosDay(Date.now() - i * 86400000);
    out.push({ date: d, value: map.get(d)?.n ?? 0, amount: map.get(d)?.v ?? 0 });
  }
  return out;
}

r.get('/analytics', wrap(async (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const since = new Date(Date.now() - days * 86400000);
  const day = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: 'Africa/Lagos' } });
  const [signups, orders, revenue, plans, subStatus, byChannel, byFulfillment, top, withMeals, withOrders, restaurants, trialsStarted, paidAfterTrial] = await Promise.all([
    User.aggregate([{ $match: { role: 'owner', createdAt: { $gte: since } } }, { $group: { _id: day('$createdAt'), n: { $sum: 1 } } }]),
    Order.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: day('$createdAt'), n: { $sum: 1 } } }]),
    SubscriptionPayment.aggregate([{ $match: { status: 'success', createdAt: { $gte: since } } }, { $group: { _id: day('$createdAt'), n: { $sum: 1 }, v: { $sum: '$amount' } } }]),
    Restaurant.aggregate([{ $group: { _id: '$plan', n: { $sum: 1 } } }]),
    Subscription.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    Order.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$channel', n: { $sum: 1 } } }]),
    Order.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$fulfillment', n: { $sum: 1 } } }]),
    Order.aggregate([
      { $match: { createdAt: { $gte: since } } }, { $group: { _id: '$restaurant', n: { $sum: 1 }, v: { $sum: '$total' } } },
      { $sort: { n: -1 } }, { $limit: 8 },
      { $lookup: { from: 'restaurants', localField: '_id', foreignField: '_id', as: 'r' } },
      { $project: { n: 1, v: 1, name: { $first: '$r.name' }, slug: { $first: '$r.slug' } } },
    ]),
    Meal.distinct('restaurant'), Order.distinct('restaurant'), Restaurant.countDocuments(),
    Subscription.countDocuments({ trialUsed: true }),
    Subscription.countDocuments({ trialUsed: true, status: 'active', lastPaymentReference: /^SUB-/ }),
  ]);
  const rev = fillDays(days, revenue);
  res.json({
    days,
    signups: fillDays(days, signups), orders: fillDays(days, orders),
    revenue: rev.map((x) => ({ date: x.date, value: x.amount })),
    totals: {
      signups: signups.reduce((s, x) => s + x.n, 0), orders: orders.reduce((s, x) => s + x.n, 0),
      revenue: revenue.reduce((s, x) => s + x.v, 0),
    },
    plans: plans.map((p) => ({ label: p._id, value: p.n })),
    subscriptionStatus: subStatus.map((p) => ({ label: p._id, value: p.n })),
    orderChannels: byChannel.map((p) => ({ label: p._id, value: p.n })),
    fulfillment: byFulfillment.map((p) => ({ label: p._id || 'unknown', value: p.n })),
    topRestaurants: top.map((t) => ({ id: t._id, name: t.name || 'Deleted restaurant', slug: t.slug, orders: t.n, value: t.v })),
    funnel: [
      { label: 'Restaurants registered', value: restaurants },
      { label: 'Added at least one meal', value: withMeals.length },
      { label: 'Received at least one order', value: withOrders.length },
      { label: 'Started a Pro trial', value: trialsStarted },
      { label: 'Paid for Pro after a trial', value: paidAfterTrial },
    ],
  });
}));

/* ================= Emails ================= */
r.get('/emails', wrap(async (req, res) => {
  const { q, status, type } = req.query; const { page, size, skip } = pg(req);
  const f = {};
  if (status) f.status = String(status);
  if (type) f.type = String(type);
  if (q) f.to = rx(q);
  const [rows, total, types] = await Promise.all([
    EmailLog.find(f).select('-payload').sort('-createdAt').skip(skip).limit(size).lean(),
    EmailLog.countDocuments(f), EmailLog.distinct('type'),
  ]);
  res.json({ rows, total, page, pages: Math.ceil(total / size), types: types.sort() });
}));
r.post('/emails/:id/retry', wrap(async (req, res) => {
  const log = await retryEmailById(req.params.id);
  if (!log) return res.status(404).json({ error: 'Not found' });
  await audit(req, 'retry_email', log._id);
  res.json({ status: log.status, lastError: log.lastError });
}));

/* ================= Logs ================= */
r.get('/error-logs', wrap(async (req, res) => {
  const { page, size, skip } = pg(req, 30);
  const [rows, total] = await Promise.all([ErrorLog.find().select('-stack').sort('-createdAt').skip(skip).limit(size).lean(), ErrorLog.countDocuments()]);
  res.json({ rows, total, page, pages: Math.ceil(total / size) });
}));
r.get('/audit', wrap(async (req, res) => {
  const { page, size, skip } = pg(req, 30); const f = req.query.action ? { action: String(req.query.action) } : {};
  const [rows, total, actions] = await Promise.all([
    AuditLog.find(f).populate('actor', 'name email').sort('-createdAt').skip(skip).limit(size).lean(), AuditLog.countDocuments(f), AuditLog.distinct('action'),
  ]);
  res.json({ rows, total, page, pages: Math.ceil(total / size), actions: actions.sort() });
}));
r.get('/payment-failures', wrap(async (req, res) => {
  const [sub, food] = await Promise.all([
    SubscriptionPayment.find({ status: 'failed' }).populate('restaurant', 'name').sort('-updatedAt').limit(50).lean(),
    OrderPayment.find({ status: 'failed' }).select('-raw').populate('restaurant', 'name').sort('-updatedAt').limit(50).lean(),
  ]);
  res.json({ subscription: sub, foodOrders: food });
}));
r.get('/integration-summary', wrap(async (req, res) => {
  const rows = await PaymentConfig.aggregate([{ $group: { _id: '$onboardingStatus', n: { $sum: 1 } } }]);
  res.json(rows); // counts only: no bank details or subaccount codes
}));

/* ================= Platform settings ================= */
r.get('/settings', wrap(async (req, res) => res.json({ platform: await getPlatformSettings(), plans: await getPlanConfig() })));

r.put('/settings', validate(z.object({
  supportEmail: z.string().email().or(z.literal('')).optional(),
  registrationOpen: z.boolean().optional(),
  announcement: z.object({ enabled: z.boolean(), text: z.string().max(300), tone: z.enum(['info', 'warning']) }).optional(),
})), wrap(async (req, res) => {
  const next = await setPlatformSettings(req.body);
  await audit(req, 'update_platform_settings', 'platform', req.body);
  res.json(next);
}));

r.get('/plans', wrap(async (req, res) => res.json(await getPlanConfig())));
r.put('/plans', validate(z.object({
  free: z.object({ maxActiveMeals: z.number().int().min(1).max(1000) }).optional(),
  pro: z.object({ priceNgn: z.number().min(100).max(10_000_000), trialDays: z.number().int().min(0).max(90) }).optional(),
})), wrap(async (req, res) => {
  const next = await setPlanConfig(req.body);
  await audit(req, 'update_plans', 'plans', req.body);
  res.json(next);
}));

export default r;
