import { Router } from 'express';
import crypto from 'crypto';
import { Complaint, Restaurant, RestaurantMessage, Order } from '../models/index.js';
import { z, validate, wrap, escapeHtml } from '../utils/helpers.js';
import { requireAuth, requireRole, loadRestaurant } from '../middleware/auth.js';
import { sendEmail, btn } from '../services/email.js';
import { notifyRestaurant } from '../services/notify.js';
import { ACTIONABLE } from '../config/plans.js';

const ref = (p) => `${p}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

/* ---------- Public: a customer writes to a restaurant ---------- */
export const publicContact = Router();
publicContact.post('/contact/:slug', validate(z.object({
  name: z.string().min(2).max(80), email: z.string().email(), phone: z.string().max(20).optional(),
  subject: z.string().max(120).optional(), message: z.string().min(5, 'Please write a short message').max(2000),
  orderRef: z.string().max(30).optional(), website: z.string().optional(), // honeypot
})), wrap(async (req, res) => {
  const b = req.body;
  if (b.website) return res.status(201).json({ ok: true });
  const rest = await Restaurant.findOne({ slug: String(req.params.slug).toLowerCase(), status: 'active' }).populate('owner', 'email name');
  if (!rest) return res.status(404).json({ error: 'Restaurant not found' });
  const m = await RestaurantMessage.create({
    restaurant: rest._id, reference: ref('MSG'), name: b.name, email: b.email.toLowerCase(), phone: b.phone,
    subject: b.subject, message: b.message, orderRef: b.orderRef ? b.orderRef.toUpperCase() : undefined,
  });
  const to = rest.email || rest.owner?.email;
  sendEmail({
    to, type: 'restaurant_new_message', dedupeKey: `rmsg:${m._id}`, restaurant: rest._id, replyTo: m.email,
    subject: `New customer message${m.subject ? `: ${m.subject}` : ''}`,
    body: `<p><b>${escapeHtml(m.name)}</b> (${escapeHtml(m.email)}${m.phone ? `, ${escapeHtml(m.phone)}` : ''}) wrote:</p>
<p style="white-space:pre-wrap">${escapeHtml(m.message).slice(0, 1200)}</p>${btn(`${process.env.CLIENT_URL}/dashboard/messages`, 'Open your messages')}`,
  });
  notifyRestaurant(rest._id, { title: `Message from ${m.name}`, body: String(m.message).slice(0, 120), url: '/dashboard/messages', tag: `msg-${m._id}` });
  sendEmail({
    to: m.email, type: 'customer_message_ack', dedupeKey: `rmsg-ack:${m._id}`, restaurant: rest._id,
    subject: `${rest.name} received your message`,
    body: `<p>Hi ${escapeHtml(m.name)}, your message to <b>${escapeHtml(rest.name)}</b> was sent. They will reply to this email address. Reference <b>${m.reference}</b>.</p>`,
  });
  res.status(201).json({ ok: true, reference: m.reference });
}));

/* ---------- Restaurant dashboard: messages from customers + reports to the platform ---------- */
const r = Router();
r.use(requireAuth, requireRole('owner'), loadRestaurant);
r.param('id', (req, res, next, id) => (/^[a-f\d]{24}$/i.test(id) ? next() : res.status(404).json({ error: 'Not found' })));

r.get('/summary', wrap(async (req, res) => {
  const rid = req.restaurant._id;
  const [unreadMessages, activeReports, newOrders, proofsToReview] = await Promise.all([
    RestaurantMessage.countDocuments({ restaurant: rid, status: 'new' }),
    Complaint.countDocuments({ restaurant: rid, source: 'restaurant', status: { $in: ['open', 'reviewed', 'in_review'] } }),
    Order.countDocuments({ restaurant: rid, status: { $in: ['pending', 'awaiting_whatsapp'] }, ...ACTIONABLE }),
    Order.countDocuments({ restaurant: rid, paymentStatus: 'awaiting_verification', status: { $ne: 'cancelled' } }),
  ]);
  res.json({ unreadMessages, activeReports, newOrders, proofsToReview });
}));

r.get('/messages', wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1), size = 20;
  const f = { restaurant: req.restaurant._id };
  if (req.query.status) f.status = String(req.query.status);
  if (req.query.q) { const e = rx(req.query.q); f.$or = [{ name: e }, { email: e }, { subject: e }, { message: e }, { orderRef: e }]; }
  const [rows, total, counts] = await Promise.all([
    RestaurantMessage.find(f).select('-replies').sort('-createdAt').skip((page - 1) * size).limit(size).lean(),
    RestaurantMessage.countDocuments(f),
    RestaurantMessage.aggregate([{ $match: { restaurant: req.restaurant._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  res.json({ rows, total, page, pages: Math.ceil(total / size), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
}));

// Tenant isolation: every lookup is scoped to the signed-in owner's restaurant.
const mine = (req) => ({ _id: req.params.id, restaurant: req.restaurant._id });

r.get('/messages/:id', wrap(async (req, res) => {
  const m = await RestaurantMessage.findOne(mine(req));
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (m.status === 'new') { m.status = 'read'; await m.save(); }
  res.json(m);
}));

r.patch('/messages/:id', validate(z.object({ status: z.enum(['new', 'read', 'closed']) })), wrap(async (req, res) => {
  const m = await RestaurantMessage.findOneAndUpdate(mine(req), { status: req.body.status }, { new: true });
  m ? res.json(m) : res.status(404).json({ error: 'Not found' });
}));

r.post('/messages/:id/reply', validate(z.object({ message: z.string().min(2).max(2000) })), wrap(async (req, res) => {
  const m = await RestaurantMessage.findOne(mine(req));
  if (!m) return res.status(404).json({ error: 'Not found' });
  m.replies.push({ by: req.restaurant.name, at: new Date(), message: req.body.message });
  m.status = 'replied'; await m.save();
  const log = await sendEmail({
    to: m.email, type: 'restaurant_reply', dedupeKey: `rmsg-reply:${m._id}:${m.replies.length}`, restaurant: req.restaurant._id,
    replyTo: req.restaurant.email || req.user.email,
    subject: `Re: ${m.subject || 'your message'} (${req.restaurant.name})`,
    body: `<p style="white-space:pre-wrap">${escapeHtml(req.body.message)}</p><p style="color:#64748b;font-size:12px">From ${escapeHtml(req.restaurant.name)} · Reference ${m.reference}. Reply to this email to answer them.</p>`,
  });
  // "accepted" only means the email provider took it.
  res.json({ message: m, email: log?.status || 'not_sent' });
}));

const STATUS_LABEL = { open: 'Received', reviewed: 'Reviewed', in_review: 'In progress', resolved: 'Resolved', dismissed: 'Closed' };
const mineReport = (req) => ({ _id: req.params.id, restaurant: req.restaurant._id, source: 'restaurant' });
const safe = (c) => ({ ...c, statusLabel: STATUS_LABEL[c.status] }); // internal notes are never selected

r.get('/reports', wrap(async (req, res) => {
  const rows = await Complaint.find({ restaurant: req.restaurant._id, source: 'restaurant' }).select('-notes').sort('-createdAt').limit(100).lean();
  res.json({ rows: rows.map(safe) });
}));

r.get('/reports/:id', wrap(async (req, res) => {
  const c = await Complaint.findOne(mineReport(req)).select('-notes').lean();
  c ? res.json(safe(c)) : res.status(404).json({ error: 'Not found' });
}));

r.post('/reports', validate(z.object({
  kind: z.enum(['complaint', 'question', 'feedback']).default('complaint'),
  subject: z.string().min(3).max(120), message: z.string().min(10, 'Please describe the problem in a sentence or two').max(2000),
})), wrap(async (req, res) => {
  const b = req.body;
  if ((await Complaint.countDocuments({ restaurant: req.restaurant._id, source: 'restaurant', createdAt: { $gte: new Date(Date.now() - 3600000) } })) >= 10)
    return res.status(429).json({ error: 'You have sent several reports in the last hour. Please wait a bit.' });
  const c = await Complaint.create({
    reference: ref('RPT'), kind: b.kind, source: 'restaurant', name: req.user.name, email: req.user.email,
    subject: b.subject, message: b.message, restaurant: req.restaurant._id,
  });
  if (process.env.ADMIN_ALERT_EMAIL) sendEmail({
    to: process.env.ADMIN_ALERT_EMAIL, type: 'admin_new_complaint', dedupeKey: `cmp:${c._id}`,
    subject: `Restaurant report ${c.reference}: ${c.subject}`,
    body: `<p><b>${escapeHtml(req.restaurant.name)}</b> wrote:</p><p style="white-space:pre-wrap">${escapeHtml(c.message).slice(0, 600)}</p>`,
  });
  sendEmail({
    to: c.email, type: 'complaint_received', dedupeKey: `cmp-ack:${c._id}`,
    subject: `We received your report (${c.reference})`,
    body: `<p>Hi ${escapeHtml(c.name)}, we received your report <b>${c.reference}</b>. You can follow its progress under Reports in your dashboard.</p>`,
  });
  res.status(201).json(safe(c.toObject()));
}));

export default r;
