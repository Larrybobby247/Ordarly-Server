// WhatsApp Commerce: the restaurant's three on/off controls (connection, automation, accepting orders).
// Owner only (staff are default-denied for /api/whatsapp in services/access.js). Every rule is enforced here and in the guards, never just in the browser.
import { Router } from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { z, validate, wrap } from '../utils/helpers.js';
import { requireAuth, loadRestaurant, requireOwner } from '../middleware/auth.js';
import { can } from '../services/access.js';
import { WhatsAppIntegration, WhatsAppConversation, WhatsAppMessage, WhatsAppControlLog, WhatsAppCreditPackage, WhatsAppCreditPurchase, OrdarlyCreditTransaction, Order } from '../models/index.js';
import { exchangeCode, loadPhone, subscribeApp, registerPhone, metaSnapshot, createOrderUpdateTemplate, listTemplates, metaConfigured } from '../services/whatsappMeta.js';
import { encryptToken, decryptToken } from '../services/tokenVault.js';
import { walletSummary, startPurchase, verifyPurchase } from '../services/whatsappCredits.js';
import { getCreditConfig } from '../services/whatsappConfig.js';
import { enqueue } from '../services/whatsappSender.js';
import * as W from '../services/whatsappPayloads.js';
import { canSendManual } from '../services/whatsappControlsStore.js';
import { restaurantUrl } from '../services/customDomain.js';
import { STATUS_INFO, evaluate } from '../services/whatsappControls.js';
import { aiStatusFor } from '../services/aiStatus.js';
import { orderNotificationStatus, resendOrderNotification } from '../services/whatsappNotify.js';
import { trackingLinkFor } from '../services/whatsappOrders.js';
import { getIntegration, updateControls, disconnect, controlHistory } from '../services/whatsappControlsStore.js';

const r = Router();
r.use(requireAuth, loadRestaurant);
// The inbox is the one area staff (with the Orders permission and every-branch access) may use. Everything else below it is owner only.
const inbox = Router();
r.use('/inbox', inbox);
r.use(requireOwner);

const stamp = (c) => (c?.at ? { at: c.at, byName: c.byName || null } : null);

/** What the dashboard sees. Contains no token and nothing secret. */
async function view(req, integ) {
  const e = evaluate(integ);
  const info = STATUS_INFO[e.status];
  const rest = req.restaurant;
  return {
    connection: {
      status: e.status, label: info.label, help: info.help, connected: e.connected,
      id: integ?._id ? String(integ._id) : null, displayPhoneNumber: integ?.displayPhoneNumber || null, verifiedDisplayName: integ?.verifiedDisplayName || null,
      lastChange: stamp(integ?.changes?.connection),
      canConnect: metaConfigured(), suspended: integ?.suspended?.at ? { at: integ.suspended.at } : null, coexistence: !!integ?.coexistenceEnabled,
      lastError: integ?.lastError?.at ? { at: integ.lastError.at, message: integ.lastError.message } : null, lastWebhookReceivedAt: integ?.lastWebhookReceivedAt || null,
    },
    automation: { enabled: e.automationEnabled, active: e.automationActive, lastChange: stamp(integ?.changes?.automation) },
    orders: {
      enabled: e.acceptOrdersEnabled, active: e.ordersActive, lastChange: stamp(integ?.changes?.orders),
      onlineOrderingUrl: restaurantUrl(rest, { customDomainActive: rest.customDomainStatus === 'active' && req.isPro }), // offered to customers while WhatsApp orders are off
    },
    history: (await controlHistory(rest._id)).map((h) => ({ control: h.control, from: h.from, to: h.to, byName: h.byName, note: h.note, at: h.createdAt })),
  };
}

const apply = async (req, res, patch) => {
  const out = await updateControls(req.restaurant._id, patch, req.user);
  if (out.error) return res.status(out.status || 409).json({ error: out.error, code: out.code });
  res.json({ ...(await view(req, out.integration)), changed: out.changed });
};

r.get('/controls', wrap(async (req, res) => res.json(await view(req, await getIntegration(req.restaurant._id)))));

// Either control, or both at once. Anything left out is not touched.
r.patch('/controls', validate(z.object({ automationEnabled: z.boolean().optional(), acceptOrdersEnabled: z.boolean().optional() })
  .refine((v) => v.automationEnabled !== undefined || v.acceptOrdersEnabled !== undefined, { message: 'Nothing to change.' })), wrap((req, res) => apply(req, res, req.body)));

r.post('/automation/toggle', validate(z.object({ enabled: z.boolean() })), wrap((req, res) => apply(req, res, { automationEnabled: req.body.enabled })));
r.post('/orders/toggle', validate(z.object({ enabled: z.boolean() })), wrap((req, res) => apply(req, res, { acceptOrdersEnabled: req.body.enabled })));

// Disconnect. The :id must be THIS restaurant's integration, so one restaurant can never disconnect another's.
r.delete('/integrations/:id', wrap(async (req, res) => {
  const integ = await getIntegration(req.restaurant._id);
  if (!integ || String(integ._id) !== req.params.id) return res.status(404).json({ error: 'WhatsApp connection not found.' });
  const out = await disconnect(req.restaurant._id, req.user);
  if (out.error) return res.status(out.status || 409).json({ error: out.error, code: out.code });
  res.json({ ...(await view(req, out.integration)), changed: out.changed, metaRevoked: out.metaRevoked, metaNote: out.metaNote });
}));

/* ======================= Connecting (Meta Embedded Signup) ======================= */
// What the browser needs to open Meta's signup popup. App id and config id are public by design; the app SECRET never leaves the server.
r.get('/config', (req, res) => res.json({ configured: metaConfigured(), appId: process.env.META_APP_ID || null, configId: process.env.META_EMBEDDED_SIGNUP_CONFIG_ID || null, apiVersion: process.env.META_API_VERSION || null }));

r.post('/embedded-signup', validate(z.object({
  code: z.string().min(10).max(2000), wabaId: z.string().regex(/^\d{5,30}$/), phoneNumberId: z.string().regex(/^\d{5,30}$/), coexistence: z.boolean().optional(),
})), wrap(async (req, res) => {
  if (!metaConfigured()) return res.status(503).json({ error: 'WhatsApp connection is not set up on this server yet.' });
  const { code, wabaId, phoneNumberId, coexistence } = req.body;
  const other = await WhatsAppIntegration.findOne({ phoneNumberId, restaurant: { $ne: req.restaurant._id }, connectionStatus: { $nin: ['not_connected', 'disconnected'] } }).select('_id').lean();
  if (other) return res.status(409).json({ error: 'That WhatsApp number is already connected to another restaurant.' });
  let token, phone;
  try {
    token = (await exchangeCode(code)).accessToken;
    phone = await loadPhone({ token, wabaId, phoneNumberId }); // the number must really belong to the authorised business account
    await subscribeApp({ token, wabaId });
  } catch (e) { console.error('[whatsapp signup]', e.message); return res.status(e.status && e.status < 500 ? 400 : 502).json({ error: e.status === 400 ? e.message : 'Meta did not complete the connection. Please try again.' }); }

  const prev = await WhatsAppIntegration.findOne({ restaurant: req.restaurant._id }).lean();
  const set = {
    wabaId, phoneNumberId, displayPhoneNumber: phone.display_phone_number, verifiedDisplayName: phone.verified_name, coexistenceEnabled: !!coexistence,
    encryptedAccessToken: encryptToken(token), connectionStatus: phone.status && phone.status !== 'CONNECTED' ? 'verification_pending' : 'connected',
    'changes.connection': { at: new Date(), by: req.user._id, byName: req.user.name },
  };
  if (!coexistence) { // a brand-new number must be registered for the Cloud API; a number used in the WhatsApp Business app (coexistence) already is
    const pin = String(crypto.randomInt(100000, 1000000));
    try { await registerPhone({ token, phoneNumberId, pin }); set.encryptedRegistrationPin = encryptToken(pin); } catch (e) { console.error('[whatsapp register]', e.message); }
  }
  const integ = await WhatsAppIntegration.findOneAndUpdate({ restaurant: req.restaurant._id }, { $set: set, $unset: { lastError: 1 }, $setOnInsert: { restaurant: req.restaurant._id } }, { upsert: true, new: true }).lean();
  await WhatsAppControlLog.create({ restaurant: req.restaurant._id, control: 'connection', from: prev?.connectionStatus || 'not_connected', to: integ.connectionStatus, by: req.user._id, byName: req.user.name, note: coexistence ? 'Connected (keeps using the WhatsApp Business app)' : 'Connected' });
  createOrderUpdateTemplate({ token, wabaId }).catch(() => {}); // best effort; it works only after Meta approves it
  res.json(await view(req, integ));
}));

/* ======================= Automation settings ======================= */
const SETTINGS = z.object({
  welcomeMessage: z.string().max(600), businessDescription: z.string().max(600), outOfHoursMessage: z.string().max(600), handoverMessage: z.string().max(600),
  categoryIds: z.array(z.string().regex(/^[a-f0-9]{24}$/)).max(100),
  allowDelivery: z.boolean(), allowPickup: z.boolean(), allowOnlinePayment: z.boolean(), allowPayOnDelivery: z.boolean(), confirmBeforeOrder: z.boolean(), handoverEnabled: z.boolean(),
  notifyStatuses: z.array(z.enum(['paid', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled'])),
  aiEnabled: z.boolean(),
  staffNotify: z.object({ push: z.boolean(), email: z.boolean() }), abandonHours: z.number().int().min(1).max(168),
}).partial().strict();

r.get('/settings', wrap(async (req, res) => { const i = await getIntegration(req.restaurant._id); res.json({ settings: i?.settings || {} }); }));
r.patch('/settings', validate(SETTINGS), wrap(async (req, res) => {
  const $set = Object.fromEntries(Object.entries(req.body).map(([k, v]) => [`settings.${k}`, v]));
  if (!Object.keys($set).length) return res.json({ settings: (await getIntegration(req.restaurant._id))?.settings || {} });
  const i = await WhatsAppIntegration.findOneAndUpdate({ restaurant: req.restaurant._id }, { $set, $setOnInsert: { restaurant: req.restaurant._id } }, { upsert: true, new: true }).lean();
  res.json({ settings: i.settings });
}));

/* ======================= AI help (Groq) status. The key and model live only on the server; restaurants only choose on/off. ======================= */
r.get('/ai-status', wrap(async (req, res) => res.json(await aiStatusFor(req.restaurant._id, await getIntegration(req.restaurant._id)))));

/* ======================= Order notifications on WhatsApp ======================= */
const orderId = z.object({}).passthrough();
r.get('/orders/:id/notifications', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const o = await Order.findOne({ _id: req.params.id, restaurant: req.restaurant._id, source: 'whatsapp' }).select('+trackingTokenEnc reference status paymentStatus').lean();
  if (!o) return res.status(404).json({ error: 'Not found' });
  res.json({ reference: o.reference, trackingLink: await trackingLinkFor(o, req.restaurant), notifications: await orderNotificationStatus(req.restaurant._id, o._id) });
}));
// Resend is rate-limited by its own dedupe key (one per minute per order+event) and goes through the normal credit / window / template rules.
r.post('/orders/:id/notifications/resend', validate(orderId), wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const out = await resendOrderNotification(req.restaurant._id, req.params.id, req.user);
  out.ok ? res.json({ ok: true }) : res.status(400).json({ error: out.error });
}));

/* ======================= Ordarly credits (separate from Meta billing) =======================
r.get('/credits', wrap(async (req, res) => {
  const [wallet, packages, cfg] = await Promise.all([walletSummary(req.restaurant._id), WhatsAppCreditPackage.find({ active: true, price: { $gt: 0 } }).sort('sort credits').lean(), getCreditConfig()]);
  res.json({ wallet, packages: packages.map((p) => ({ id: String(p._id), name: p.name, credits: p.credits, price: p.price, expiryDays: p.expiryDays ?? null })), policy: cfg.purchasedCreditPolicy, rules: 'One credit is used for each WhatsApp message that is successfully delivered. Messages you receive, and messages that fail, cost nothing. Monthly credits are used first.' });
}));
r.get('/credits/transactions', wrap(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1), limit = 25;
  const q = { restaurant: req.restaurant._id, transactionType: { $ne: 'message_reservation' } };
  const [rows, total] = await Promise.all([OrdarlyCreditTransaction.find(q).sort('-createdAt').skip((page - 1) * limit).limit(limit).select('-adminId -reference').lean(), OrdarlyCreditTransaction.countDocuments(q)]);
  res.json({ transactions: rows, total, page, pages: Math.ceil(total / limit) });
}));
r.post('/credits/purchase', validate(z.object({ packageId: z.string().regex(/^[a-f0-9]{24}$/) })), wrap(async (req, res) => res.json(await startPurchase(req.restaurant, req.body.packageId))));
// After Paystack sends the customer back, the browser asks us to check. The server asks Paystack itself; the browser's word is never used.
r.post('/credits/verify', validate(z.object({ reference: z.string().regex(/^WAC-[a-f0-9]{20}$/) })), wrap(async (req, res) => {
  const p = await WhatsAppCreditPurchase.findOne({ providerReference: req.body.reference, restaurant: req.restaurant._id });
  if (!p) return res.status(404).json({ error: 'Purchase not found.' });
  const out = await verifyPurchase(p);
  res.json({ status: out.status, wallet: await walletSummary(req.restaurant._id) });
}));
r.get('/credits/purchases', wrap(async (req, res) => res.json({ purchases: await WhatsAppCreditPurchase.find({ restaurant: req.restaurant._id }).sort('-createdAt').limit(20).select('packageName credits amount status createdAt providerReference').lean() })));

/* ======================= Usage, Meta status, performance ======================= */
const NA = 'Not available from Meta.';
r.get('/meta-status', wrap(async (req, res) => {
  const i = await WhatsAppIntegration.findOne({ restaurant: req.restaurant._id }).select('+encryptedAccessToken').lean();
  if (!i?.wabaId || !i.phoneNumberId) return res.json({ connected: false });
  const stale = !i.meta?.fetchedAt || Date.now() - new Date(i.meta.fetchedAt) > 10 * 60000;
  let meta = i.meta;
  if ((stale || req.query.refresh === '1') && i.encryptedAccessToken && metaConfigured()) {
    try {
      const snap = await metaSnapshot({ token: decryptToken(i.encryptedAccessToken), wabaId: i.wabaId, phoneNumberId: i.phoneNumberId });
      let templates = i.templates; try { const t = await listTemplates({ token: decryptToken(i.encryptedAccessToken), wabaId: i.wabaId }); const o = t.find((x) => x.name === 'ordarly_order_update'); templates = { ...(i.templates || {}), order_update: o ? { name: o.name, status: o.status } : i.templates?.order_update }; } catch { /* keep what we had */ }
      meta = { fetchedAt: snap.fetchedAt, error: snap.error, phone: snap.phone, waba: snap.waba, pricing: snap.pricing };
      await WhatsAppIntegration.updateOne({ _id: i._id }, { $set: { meta, ...(templates && { templates }) } });
      i.templates = templates;
    } catch (e) { meta = { ...(meta || {}), error: e.message }; }
  }
  const p = meta?.phone || {}, w = meta?.waba || {};
  const v = (x) => (x === undefined || x === null || x === '' ? NA : x); // never invent a value Meta did not give
  res.json({
    connected: true, fetchedAt: meta?.fetchedAt || null, error: meta?.error || null,
    phone: { number: v(i.displayPhoneNumber), verifiedName: v(i.verifiedDisplayName), quality: v(p.quality_rating), messagingLimitTier: v(p.messaging_limit_tier), status: v(p.status), nameStatus: v(p.name_status), platform: v(p.platform_type) },
    account: { name: v(w.name), currency: v(w.currency), reviewStatus: v(w.account_review_status), businessVerification: v(w.business_verification_status), health: w.health_status?.can_send_message ? w.health_status.can_send_message : NA },
    billing: { freeAllowance: NA, pricing: meta?.pricing?.pricing_analytics ? meta.pricing.pricing_analytics : NA, note: 'WhatsApp charges for messages are billed by Meta to your WhatsApp Business Account. They are separate from your Ordarly credits and are not shown or paid here.' },
    templates: i.templates?.order_update ? { orderUpdate: i.templates.order_update.status || NA } : { orderUpdate: NA },
  });
}));

r.get('/usage', wrap(async (req, res) => {
  const rid = req.restaurant._id; const since = new Date(Date.now() - 30 * 86400000);
  const [wallet, sent, byStatus, orders, convs, handovers, failed] = await Promise.all([
    walletSummary(rid),
    WhatsAppMessage.countDocuments({ restaurant: rid, direction: 'outbound', createdAt: { $gte: since } }),
    WhatsAppMessage.aggregate([{ $match: { restaurant: rid, direction: 'outbound', createdAt: { $gte: since } } }, { $group: { _id: '$deliveryStatus', n: { $sum: 1 } } }]),
    Order.aggregate([{ $match: { restaurant: rid, source: 'whatsapp', createdAt: { $gte: since } } }, { $group: { _id: null, n: { $sum: 1 }, paid: { $sum: { $cond: [{ $in: ['$paymentStatus', ['paid', 'paid_manual']] }, 1, 0] } }, revenue: { $sum: { $cond: [{ $in: ['$paymentStatus', ['paid', 'paid_manual']] }, '$subtotal', 0] } } } }]),
    WhatsAppConversation.countDocuments({ restaurant: rid, createdAt: { $gte: since } }),
    WhatsAppConversation.countDocuments({ restaurant: rid, handoverAt: { $gte: since } }),
    WhatsAppMessage.find({ restaurant: rid, direction: 'outbound', sendStatus: 'failed', createdAt: { $gte: since } }).sort('-createdAt').limit(10).select('content failureReason failureKind createdAt').lean(),
  ]);
  const o = orders[0] || { n: 0, paid: 0, revenue: 0 };
  res.json({ credits: wallet, last30Days: { messagesSent: sent, byDeliveryStatus: Object.fromEntries(byStatus.map((x) => [x._id || 'unknown', x.n])), conversations: convs, handovers, orders: o.n, paidOrders: o.paid, foodRevenue: o.revenue }, recentFailures: failed });
}));

/* ======================= Inbox (owner, or staff with Orders permission and every-branch access) ======================= */
inbox.use((req, res, next) => (can(req.access, 'orders') && (req.access.isOwner || req.access.allBranches) ? next() : res.status(403).json({ error: 'You do not have access to the WhatsApp inbox.', code: 'FORBIDDEN' })));
const oidOk = (id) => mongoose.isValidObjectId(id);
const conv = (req) => (oidOk(req.params.id) ? WhatsAppConversation.findOne({ _id: req.params.id, restaurant: req.restaurant._id }) : null);
const cancelQueued = (id) => WhatsAppMessage.updateMany({ conversation: id, automated: true, sendStatus: 'queued', allowDuringHuman: false }, { $set: { sendStatus: 'cancelled', deliveryStatus: 'failed', failureKind: 'handover', failureReason: 'A team member took over this conversation.' } });

inbox.get('/conversations', wrap(async (req, res) => {
  const q = { restaurant: req.restaurant._id };
  const st = String(req.query.status || '');
  if (st === 'needs_attention') q.status = 'human_pending'; else if (['bot_active', 'human_pending', 'human_active', 'resolved'].includes(st)) q.status = st;
  if (req.query.unread === '1') q.unreadCount = { $gt: 0 };
  const page = Math.max(1, Number(req.query.page) || 1), limit = 30;
  const [rows, total, attention] = await Promise.all([
    WhatsAppConversation.find(q).sort('-lastActivityAt').skip((page - 1) * limit).limit(limit).select('customerWaId customerPhone customerName status unreadCount lastMessagePreview lastMessageDirection lastActivityAt assignedStaffName handoverReason conversationState').lean(),
    WhatsAppConversation.countDocuments(q), WhatsAppConversation.countDocuments({ restaurant: req.restaurant._id, status: 'human_pending' }),
  ]);
  res.json({ conversations: rows.map((c) => ({ ...c, customerWaId: undefined, phone: c.customerPhone || null })), total, page, pages: Math.ceil(total / limit), needsAttention: attention });
}));

inbox.get('/conversations/:id', wrap(async (req, res) => {
  const c = await conv(req); if (!c) return res.status(404).json({ error: 'Conversation not found.' });
  const messages = await WhatsAppMessage.find({ conversation: c._id }).sort('-timestamp').limit(100).select('direction content origin sentByName automated deliveryStatus sendStatus failureReason timestamp messageType').lean();
  await WhatsAppConversation.updateOne({ _id: c._id }, { unreadCount: 0 });
  const orders = await Order.find({ restaurant: req.restaurant._id, source: 'whatsapp', customerPhone: c.customerPhone || '__none__' }).sort('-createdAt').limit(5).select('reference status total paymentStatus createdAt').lean();
  const cart = c.currentCart?.length ? c.currentCart.length : 0;
  res.json({ conversation: { _id: c._id, customerName: c.customerName, phone: c.customerPhone || null, status: c.status, assignedStaffName: c.assignedStaffName, handoverReason: c.handoverReason, cartLines: cart, windowOpen: !!(c.lastCustomerMessageAt && Date.now() - new Date(c.lastCustomerMessageAt) < 24 * 3600000) }, messages: messages.reverse(), orders });
}));

inbox.post('/conversations/:id/reply', validate(z.object({ text: z.string().trim().min(1).max(1500) })), wrap(async (req, res) => {
  const c = await conv(req); if (!c) return res.status(404).json({ error: 'Conversation not found.' });
  const g = await canSendManual(req.restaurant._id);
  if (!g.ok) return res.status(409).json({ error: g.message, code: g.reason.toUpperCase() });
  if (c.status !== 'human_active') { // replying means a person has taken over
    await WhatsAppConversation.updateOne({ _id: c._id }, { $set: { status: 'human_active', humanTakeover: true, assignedStaffId: req.user._id, assignedStaffName: req.user.name } });
    await cancelQueued(c._id);
  }
  const m = await enqueue(c, W.text(req.body.text), { automated: false, origin: 'staff', user: req.user });
  res.status(202).json({ id: m._id });
}));
inbox.post('/conversations/:id/takeover', wrap(async (req, res) => {
  const c = await conv(req); if (!c) return res.status(404).json({ error: 'Conversation not found.' });
  await WhatsAppConversation.updateOne({ _id: c._id }, { $set: { status: 'human_active', humanTakeover: true, assignedStaffId: req.user._id, assignedStaffName: req.user.name } });
  await cancelQueued(c._id); res.json({ ok: true });
}));
inbox.post('/conversations/:id/resume', wrap(async (req, res) => { // hand the chat back to the automatic assistant
  const c = await conv(req); if (!c) return res.status(404).json({ error: 'Conversation not found.' });
  await WhatsAppConversation.updateOne({ _id: c._id }, { $set: { status: 'bot_active', humanTakeover: false, failedAttempts: 0, conversationState: 'greeting', flow: {} }, $unset: { handoverAckAt: 1, assignedStaffId: 1, assignedStaffName: 1 } });
  res.json({ ok: true });
}));
inbox.post('/conversations/:id/close', wrap(async (req, res) => {
  const c = await conv(req); if (!c) return res.status(404).json({ error: 'Conversation not found.' });
  await WhatsAppConversation.updateOne({ _id: c._id }, { $set: { status: 'resolved', humanTakeover: false, unreadCount: 0 } }); res.json({ ok: true });
}));

export default r;
