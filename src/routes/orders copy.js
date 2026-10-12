import { Router } from 'express';
import { Order, PaymentProof } from '../models/index.js';
import { readProof, sniffImage } from '../services/storage.js';
import { z, validate, wrap, escapeHtml, naira } from '../utils/helpers.js';
import { requireAuth, loadRestaurant, requirePro } from '../middleware/auth.js';
import { ORDER_TRANSITIONS } from '../config/plans.js';
import { sendEmail } from '../services/email.js';

const r = Router();
r.use(requireAuth, loadRestaurant);

r.get('/', wrap(async (req, res) => {
  const { status, fulfillment, paymentMethod, q, from, to, page = 1 } = req.query;
  const f = { restaurant: req.restaurant._id };
  if (status) f.status = String(status);
  if (fulfillment) f.fulfillment = String(fulfillment);
  if (paymentMethod) f.paymentMethod = String(paymentMethod);
  if (from || to) f.createdAt = { ...(from && { $gte: new Date(from) }), ...(to && { $lte: new Date(to) }) };
  if (q) { const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); f.$or = [{ reference: rx }, { customerName: rx }, { customerPhone: rx }]; }
  const limit = 25;
  const [orders, total] = await Promise.all([
    Order.find(f).select('-trackingTokenHash -idempotencyKey').sort('-createdAt').skip((Number(page) - 1) * limit).limit(limit).lean(),
    Order.countDocuments(f),
  ]);
  res.json({ orders, total, page: Number(page), pages: Math.ceil(total / limit) });
}));

// Today's counts by status (Lagos day) for the Orders page tiles, plus what still needs attention overall.
r.get('/summary', wrap(async (req, res) => {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  const start = new Date(`${day}T00:00:00+01:00`);
  const rid = req.restaurant._id;
  const [today, waiting] = await Promise.all([
    Order.aggregate([{ $match: { restaurant: rid, createdAt: { $gte: start } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Order.countDocuments({ restaurant: rid, status: { $in: ['pending', 'awaiting_whatsapp'] } }),
  ]);
  const by = Object.fromEntries(today.map((x) => [x._id, x.n]));
  res.json({ day, byStatus: by, total: today.reduce((s, x) => s + x.n, 0), waiting });
}));

r.get('/:id', wrap(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, restaurant: req.restaurant._id }).select('-trackingTokenHash').lean();
  o ? res.json(o) : res.status(404).json({ error: 'Not found' });
}));

const push = (o, by, field, from, to, note) => o.audit.push({ at: new Date(), by, field, from, to, note });

r.patch('/:id/status', validate(z.object({ status: z.string() })), wrap(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, restaurant: req.restaurant._id });
  if (!o) return res.status(404).json({ error: 'Not found' });
  const next = req.body.status;
  if (!(ORDER_TRANSITIONS[o.status] || []).includes(next)) return res.status(400).json({ error: `Cannot move from ${o.status} to ${next}` });
  if (o.channel === 'whatsapp' && ['out_for_delivery'].includes(next)) return res.status(402).json({ error: 'Not available for WhatsApp orders' });
  push(o, String(req.user._id), 'status', o.status, next);
  o.status = next; await o.save();
  if (o.channel === 'checkout' && o.customerEmail && req.isPro)
    sendEmail({ to: o.customerEmail, type: 'order_status', restaurant: o.restaurant, order: o._id, dedupeKey: `status:${o._id}:${next}`,
      subject: `Order ${o.reference}: ${next.replace(/_/g, ' ')}`, body: `<p>Your order is now <b>${escapeHtml(next.replace(/_/g, ' '))}</b>.</p>` });
  res.json(o);
}));

// Pay-on-delivery collected (Pro). Never auto-set by order status.
r.post('/:id/pod-collected', requirePro('Pay on delivery'), wrap(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, restaurant: req.restaurant._id, paymentMethod: 'pod' });
  if (!o) return res.status(404).json({ error: 'Not found' });
  if (o.paymentStatus !== 'unpaid_pod') return res.status(400).json({ error: 'Payment is not awaiting collection' });
  push(o, String(req.user._id), 'paymentStatus', o.paymentStatus, 'paid', 'POD collected');
  o.paymentStatus = 'paid'; await o.save();
  res.json(o);
}));

/* ---------- Bank-transfer proof review ---------- */
// View proof image: owner-scoped, streamed through the API, never a public URL.
r.get('/:id/proof', wrap(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, restaurant: req.restaurant._id }).select('_id');
  if (!o) return res.status(404).json({ error: 'Not found' });
  const proof = await PaymentProof.findOne({ order: o._id, restaurant: req.restaurant._id }).sort('-createdAt');
  if (!proof) return res.status(404).json({ error: 'No proof uploaded' });
  try {
    const buf = await readProof(proof.fileRef);
    const kind = sniffImage(buf);
    res.set({ 'Content-Type': kind?.mime || 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
    res.send(buf);
  } catch { res.status(404).json({ error: 'Proof file unavailable' }); }
}));

r.get('/:id/proof-info', wrap(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, restaurant: req.restaurant._id }).select('_id');
  if (!o) return res.status(404).json({ error: 'Not found' });
  const proof = await PaymentProof.findOne({ order: o._id, restaurant: req.restaurant._id }).sort('-createdAt').select('status reviewNotes reviewedAt createdAt');
  res.json({ proof });
}));

r.post('/:id/proof/review', requirePro('Payment proof review'), validate(z.object({
  decision: z.enum(['accept', 'reject']), notes: z.string().max(300).optional(),
  confirmReceived: z.boolean().optional(),
})), wrap(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, restaurant: req.restaurant._id, paymentMethod: 'bank_transfer' });
  if (!o) return res.status(404).json({ error: 'Not found' });
  const proof = await PaymentProof.findOne({ order: o._id, restaurant: req.restaurant._id, status: 'pending' }).sort('-createdAt');
  if (!proof || o.paymentStatus !== 'awaiting_verification') return res.status(409).json({ error: 'No proof is waiting for review.' });

  if (req.body.decision === 'accept') {
    // The restaurant must explicitly confirm the money actually reached its bank account.
    if (req.body.confirmReceived !== true) return res.status(400).json({ error: 'Confirm that you have checked your bank records and received the money.' });
    proof.status = 'accepted';
    push(o, String(req.user._id), 'paymentStatus', o.paymentStatus, 'paid_manual', 'Proof accepted by restaurant');
    o.paymentStatus = 'paid_manual';
  } else {
    proof.status = 'rejected';
    push(o, String(req.user._id), 'paymentStatus', o.paymentStatus, 'rejected', req.body.notes || 'Proof rejected');
    o.paymentStatus = 'rejected';
  }
  proof.reviewer = req.user._id; proof.reviewNotes = req.body.notes; proof.reviewedAt = new Date();
  await proof.save(); await o.save();

  const accepted = req.body.decision === 'accept';
  sendEmail({ to: o.customerEmail, type: accepted ? 'proof_accepted' : 'proof_rejected', restaurant: o.restaurant, order: o._id,
    dedupeKey: `proofrev:${proof._id}`,
    subject: accepted ? `Payment confirmed for ${o.reference}` : `Payment proof not accepted for ${o.reference}`,
    body: accepted ? `<p>${escapeHtml(req.restaurant.name)} confirmed your transfer of <b>${naira(o.total)}</b>.</p>`
      : `<p>${escapeHtml(req.restaurant.name)} could not confirm your transfer.${req.body.notes ? ' Reason: ' + escapeHtml(req.body.notes) : ''} Please upload a clearer proof or contact the restaurant.</p>` });
  res.json(o);
}));

export default r;
