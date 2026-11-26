// Ordarly administrator: WhatsApp Commerce overview, credits, packages and per-restaurant controls. Admin role only.
// Credit adjustments always record who, which restaurant, how many, why, when, and the balance before and after.
import { Router } from 'express';
import mongoose from 'mongoose';
import { z, validate, wrap } from '../utils/helpers.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { Restaurant, WhatsAppIntegration, WhatsAppMessage, WhatsAppConversation, WhatsAppCreditPackage, WhatsAppCreditPurchase, OrdarlyCreditTransaction, OrdarlyCreditWallet, Order, AuditLog } from '../models/index.js';
import { getCreditConfig, setCreditConfig } from '../services/whatsappConfig.js';
import { walletSummary, adminAdjust } from '../services/whatsappCredits.js';
import { aiAdminSnapshot } from '../services/aiStatus.js';
import { setAiLimits } from '../services/aiStore.js';
import { aiStore } from '../services/aiStore.js';
import { STATUS_INFO } from '../services/whatsappControls.js';

const r = Router();
r.use(requireAuth, requireRole('admin'));
r.param('id', (req, res, next, id) => (mongoose.isValidObjectId(id) ? next() : res.status(404).json({ error: 'Not found' })));
const audit = (req, action, target, detail) => AuditLog.create({ actor: req.user._id, action, target: String(target), detail }).catch(() => {});
const since = (d) => new Date(Date.now() - d * 86400000);

r.get('/overview', wrap(async (req, res) => {
  const [byStatus, auto, orders, msgs, failed, creditsUsed, pending] = await Promise.all([
    WhatsAppIntegration.aggregate([{ $group: { _id: '$connectionStatus', n: { $sum: 1 } } }]),
    WhatsAppIntegration.countDocuments({ connectionStatus: 'connected', automationEnabled: true }),
    Order.aggregate([{ $match: { source: 'whatsapp', createdAt: { $gte: since(30) } } }, { $group: { _id: null, n: { $sum: 1 }, revenue: { $sum: { $cond: [{ $in: ['$paymentStatus', ['paid', 'paid_manual']] }, '$subtotal', 0] } } } }]),
    WhatsAppMessage.countDocuments({ direction: 'outbound', createdAt: { $gte: since(30) } }),
    WhatsAppMessage.countDocuments({ direction: 'outbound', sendStatus: 'failed', createdAt: { $gte: since(30) } }),
    OrdarlyCreditTransaction.aggregate([{ $match: { transactionType: 'message_deduction', createdAt: { $gte: since(30) } } }, { $group: { _id: null, n: { $sum: { $abs: '$amount' } } } }]),
    WhatsAppCreditPurchase.aggregate([{ $match: { status: 'success', createdAt: { $gte: since(30) } } }, { $group: { _id: null, n: { $sum: 1 }, amount: { $sum: '$amount' }, credits: { $sum: '$credits' } } }]),
  ]);
  const wallets = await OrdarlyCreditWallet.find({}).select('monthlyAllowance monthlyUsed purchasedBalance').lean();
  res.json({
    connections: Object.fromEntries(byStatus.map((x) => [x._id, x.n])), automationOn: auto,
    last30Days: { whatsappOrders: orders[0]?.n || 0, whatsappFoodRevenue: orders[0]?.revenue || 0, messagesSent: msgs, failedMessages: failed, creditsUsed: creditsUsed[0]?.n || 0, creditPurchases: pending[0] || { n: 0, amount: 0, credits: 0 } },
    restaurantsWithZeroCredits: wallets.filter((w) => (w.monthlyAllowance - w.monthlyUsed) + w.purchasedBalance <= 0).length,
  });
}));

r.get('/restaurants', wrap(async (req, res) => {
  const q = {}; if (req.query.status) q.connectionStatus = String(req.query.status);
  const rows = await WhatsAppIntegration.find(q).sort('-updatedAt').limit(200).select('restaurant displayPhoneNumber connectionStatus automationEnabled acceptOrdersEnabled suspended lastError lastWebhookReceivedAt').lean();
  const rests = await Restaurant.find({ _id: { $in: rows.map((x) => x.restaurant) } }).select('name slug').lean();
  const wallets = await OrdarlyCreditWallet.find({ restaurant: { $in: rows.map((x) => x.restaurant) } }).select('restaurant plan monthlyAllowance monthlyUsed purchasedBalance').lean();
  const rm = new Map(rests.map((x) => [String(x._id), x])), wm = new Map(wallets.map((x) => [String(x.restaurant), x]));
  res.json({ restaurants: rows.map((i) => { const w = wm.get(String(i.restaurant)); return { id: String(i.restaurant), name: rm.get(String(i.restaurant))?.name, slug: rm.get(String(i.restaurant))?.slug, number: i.displayPhoneNumber, status: i.connectionStatus, statusLabel: STATUS_INFO[i.connectionStatus]?.label, automation: !!i.automationEnabled, orders: !!i.acceptOrdersEnabled, suspended: !!i.suspended?.at, lastError: i.lastError?.message || null, lastWebhook: i.lastWebhookReceivedAt, plan: w?.plan, creditsLeft: w ? Math.max(0, w.monthlyAllowance - w.monthlyUsed) + w.purchasedBalance : null }; }) });
}));

r.get('/restaurants/:id', wrap(async (req, res) => {
  const [rest, integ] = await Promise.all([Restaurant.findById(req.params.id).select('name slug email').lean(), WhatsAppIntegration.findOne({ restaurant: req.params.id }).select('-encryptedAccessToken -encryptedRegistrationPin').lean()]);
  if (!rest) return res.status(404).json({ error: 'Restaurant not found' });
  const [wallet, tx, failures, orders] = await Promise.all([
    walletSummary(req.params.id), OrdarlyCreditTransaction.find({ restaurant: req.params.id, transactionType: { $ne: 'message_reservation' } }).sort('-createdAt').limit(30).lean(),
    WhatsAppMessage.find({ restaurant: req.params.id, sendStatus: 'failed' }).sort('-createdAt').limit(15).select('content failureKind failureReason failureCode createdAt').lean(),
    Order.countDocuments({ restaurant: req.params.id, source: 'whatsapp' }),
  ]);
  res.json({ restaurant: rest, integration: integ ? { ...integ, templates: integ.templates } : null, wallet, transactions: tx, failures, whatsappOrders: orders });
}));

// Suspend / unsuspend: a suspended restaurant sends nothing and takes no new WhatsApp orders; its history and credits are untouched.
r.post('/restaurants/:id/suspend', validate(z.object({ reason: z.string().trim().min(3).max(300) })), wrap(async (req, res) => {
  const i = await WhatsAppIntegration.findOneAndUpdate({ restaurant: req.params.id }, { $set: { suspended: { at: new Date(), by: req.user._id, reason: req.body.reason } } }, { new: true });
  if (!i) return res.status(404).json({ error: 'No WhatsApp connection for this restaurant.' });
  await WhatsAppMessage.updateMany({ restaurant: req.params.id, sendStatus: 'queued', automated: true }, { $set: { sendStatus: 'cancelled', deliveryStatus: 'failed', failureKind: 'suspended', failureReason: 'WhatsApp was suspended for this restaurant.' } });
  audit(req, 'whatsapp.suspend', req.params.id, { reason: req.body.reason }); res.json({ ok: true });
}));
r.post('/restaurants/:id/unsuspend', wrap(async (req, res) => {
  const i = await WhatsAppIntegration.findOneAndUpdate({ restaurant: req.params.id }, { $unset: { suspended: 1 } }, { new: true });
  if (!i) return res.status(404).json({ error: 'No WhatsApp connection for this restaurant.' });
  audit(req, 'whatsapp.unsuspend', req.params.id, {}); res.json({ ok: true });
}));

r.post('/restaurants/:id/credits', validate(z.object({ amount: z.number().int().refine((n) => n !== 0, 'Enter a non-zero amount').refine((n) => Math.abs(n) <= 1_000_000), pool: z.enum(['monthly', 'purchased']).default('purchased'), reason: z.string().trim().min(3).max(300) })), wrap(async (req, res) => {
  if (!(await Restaurant.exists({ _id: req.params.id }))) return res.status(404).json({ error: 'Restaurant not found' });
  const out = await adminAdjust({ restaurantId: req.params.id, amount: req.body.amount, pool: req.body.pool, reason: req.body.reason, admin: req.user });
  audit(req, 'whatsapp.credit_adjust', req.params.id, { amount: req.body.amount, pool: req.body.pool, reason: req.body.reason, ...out });
  res.json({ ...out, wallet: await walletSummary(req.params.id) });
}));

/* ---------- allowances and rules (all admin-editable; nothing is fixed in code) ---------- */
/* ---------- Groq AI help: monitoring, limits, emergency switch. Separate from Ordarly credits and Meta billing. ---------- */
r.get('/ai', wrap(async (req, res) => res.json(await aiAdminSnapshot())));
const LIM = z.object({
  disabled: z.boolean(), globalDailyRequests: z.number().int().min(0).max(10_000_000), perRestaurantDailyRequests: z.number().int().min(0).max(1_000_000),
  perRestaurantMonthlyRequests: z.number().int().min(0).max(10_000_000), confidenceThreshold: z.number().min(0.5).max(0.95),
  costPer1kInputUsd: z.number().min(0).max(1000), costPer1kOutputUsd: z.number().min(0).max(1000),
}).partial().strict();
r.put('/ai/limits', validate(LIM), wrap(async (req, res) => { const v = await setAiLimits(req.body); audit(req, 'whatsapp.ai_limits', 'ai', req.body); res.json({ limits: v }); }));
r.post('/ai/disable', validate(z.object({ disabled: z.boolean() })), wrap(async (req, res) => { const v = await setAiLimits({ disabled: req.body.disabled }); audit(req, req.body.disabled ? 'whatsapp.ai_disable' : 'whatsapp.ai_enable', 'ai', {}); res.json({ limits: v }); }));
r.post('/ai/reset-breaker', wrap(async (req, res) => { await aiStore.reset(); audit(req, 'whatsapp.ai_breaker_reset', 'ai', {}); res.json({ ok: true }); }));

r.get('/config', wrap(async (req, res) => res.json(await getCreditConfig())));
r.put('/config', validate(z.object({
  allowances: z.object({ free: z.number().int().min(0).max(1e7), pro: z.number().int().min(0).max(1e7), business: z.number().int().min(0).max(1e7) }).partial().optional(),
  reservationTimeoutHours: z.number().min(1).max(720).optional(), warnAtPercent: z.tuple([z.number().min(1).max(99), z.number().min(1).max(99)]).optional(), purchasedCreditPolicy: z.string().max(600).optional(),
})), wrap(async (req, res) => { const c = await setCreditConfig(req.body); audit(req, 'whatsapp.config', 'platform', req.body); res.json(c); }));

/* ---------- credit packages ---------- */
const PKG = z.object({ name: z.string().trim().min(1).max(60), credits: z.number().int().min(1).max(1e7), price: z.number().min(0).max(1e8), active: z.boolean(), expiryDays: z.number().int().min(1).max(3650).nullable(), sort: z.number().int().min(0).max(1000) });
r.get('/packages', wrap(async (req, res) => res.json({ packages: await WhatsAppCreditPackage.find({}).sort('sort credits').lean() })));
r.post('/packages', validate(PKG.partial({ active: true, expiryDays: true, sort: true, price: true })), wrap(async (req, res) => { const p = await WhatsAppCreditPackage.create(req.body); audit(req, 'whatsapp.package_create', p._id, req.body); res.status(201).json(p); }));
r.patch('/packages/:id', validate(PKG.partial()), wrap(async (req, res) => {
  if (req.body.active === true || req.body.price !== undefined) { const cur = await WhatsAppCreditPackage.findById(req.params.id).lean(); const price = req.body.price ?? cur?.price; if (req.body.active === true && !(price > 0)) return res.status(400).json({ error: 'Set a price above zero before turning a package on.' }); }
  const p = await WhatsAppCreditPackage.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true }); if (!p) return res.status(404).json({ error: 'Package not found' });
  audit(req, 'whatsapp.package_update', p._id, req.body); res.json(p);
}));

r.get('/purchases', wrap(async (req, res) => res.json({ purchases: await WhatsAppCreditPurchase.find(req.query.status ? { status: String(req.query.status) } : {}).sort('-createdAt').limit(100).populate('restaurant', 'name').lean() })));
r.get('/failed-messages', wrap(async (req, res) => res.json({ messages: await WhatsAppMessage.find({ sendStatus: 'failed', createdAt: { $gte: since(14) } }).sort('-createdAt').limit(100).select('restaurant content failureKind failureReason failureCode createdAt').populate('restaurant', 'name').lean() })));

export default r;
