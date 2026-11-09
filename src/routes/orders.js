import { Router } from 'express';
import { Order, OrderPayment, PaymentProof } from '../models/index.js';
import { readProof, sniffImage } from '../services/storage.js';
import mongoose from 'mongoose';
import { z, validate, wrap, escapeHtml, naira } from '../utils/helpers.js';
import { requireAuth, loadRestaurant, requirePro, requirePerm, requireOwner } from '../middleware/auth.js';
import { branchFilter, canBranch } from '../services/access.js';
import { completeSale, reverseSale, recordSale, applyRefund } from '../services/ledger.js';
import { releaseSlot } from '../services/scheduling.js';
import { ORDER_TRANSITIONS, needsPaymentFirst, ACTIONABLE } from '../config/plans.js';
import { sendEmail } from '../services/email.js';
import { verifyOrderPayment } from '../services/orderPayments.js';

const r = Router();
r.use(requireAuth, loadRestaurant, requirePerm('orders'));

/** Every order query is scoped to the caller's restaurant AND, for staff, to the branches they were given. */
const scope = (req, extra = {}) => ({ restaurant: req.restaurant._id, ...branchFilter(req.access), ...extra });

r.get('/', wrap(async (req, res) => {
  const { status, fulfillment, paymentMethod, q, from, to, page = 1, type, branch } = req.query;
  const f = scope(req);
  if (branch) { // a specific branch (or 'main' = orders placed with no branch); staff can only pick branches they hold
    if (branch === 'main') { if (!req.access.isOwner && !req.access.allBranches) return res.status(403).json({ error: 'You do not have access to that branch.' }); f.branch = null; }
    else if (mongoose.isValidObjectId(branch) && canBranch(req.access, branch)) f.branch = branch;
    else return res.status(403).json({ error: 'You do not have access to that branch.' });
  }
  // ASAP vs scheduled. A scheduled order is never "just a new order": it keeps its own date and its own lists.
  if (type === 'asap') f.isScheduled = { $ne: true };
  else if (type === 'scheduled') f.isScheduled = true;
  else if (type === 'upcoming') { f.isScheduled = true; f.status = { $nin: ['completed', 'cancelled'] }; }
  else if (type === 'scheduled_done') { f.isScheduled = true; f.status = 'completed'; }
  if (status && type !== 'upcoming' && type !== 'scheduled_done') f.status = String(status);
  if (fulfillment) f.fulfillment = String(fulfillment);
  if (paymentMethod) f.paymentMethod = String(paymentMethod);
  if (from || to) f.createdAt = { ...(from && { $gte: new Date(from) }), ...(to && { $lte: new Date(to) }) };
  if (q) { const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); f.$or = [{ reference: rx }, { customerName: rx }, { customerPhone: rx }]; }
  const limit = 25;
  const [orders, total] = await Promise.all([
    Order.find(f).select('-trackingTokenHash -idempotencyKey').sort(type === 'upcoming' ? 'scheduledFor' : '-createdAt').skip((Number(page) - 1) * limit).limit(limit).lean(),
    Order.countDocuments(f),
  ]);
  res.json({ orders, total, page: Number(page), pages: Math.ceil(total / limit) });
}));

// Today's counts by status (Lagos day) for the Orders page tiles, plus what still needs attention overall.
r.get('/summary', wrap(async (req, res) => {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  const start = new Date(`${day}T00:00:00+01:00`);
  const base = scope(req);
  const [today, waiting, upcoming] = await Promise.all([
    Order.aggregate([{ $match: { ...base, createdAt: { $gte: start } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Order.countDocuments({ ...base, status: { $in: ['pending', 'awaiting_whatsapp'] }, isScheduled: { $ne: true }, ...ACTIONABLE }),
    Order.countDocuments({ ...base, isScheduled: true, status: { $nin: ['completed', 'cancelled'] }, ...ACTIONABLE }),
  ]);
  const by = Object.fromEntries(today.map((x) => [x._id, x.n]));
  res.json({ day, byStatus: by, total: today.reduce((s, x) => s + x.n, 0), waiting, upcomingScheduled: upcoming });
}));

r.get('/:id', wrap(async (req, res) => {
  const o = await Order.findOne(scope(req, { _id: req.params.id })).select('-trackingTokenHash').lean();
  o ? res.json(o) : res.status(404).json({ error: 'Not found' });
}));

const push = (o, by, field, from, to, note) => o.audit.push({ at: new Date(), by, field, from, to, note });

r.patch('/:id/status', validate(z.object({ status: z.string() })), wrap(async (req, res) => {
  const o = await Order.findOne(scope(req, { _id: req.params.id }));
  if (!o) return res.status(404).json({ error: 'Not found' });
  const next = req.body.status;
  if (!(ORDER_TRANSITIONS[o.status] || []).includes(next)) return res.status(400).json({ error: `Cannot move from ${o.status} to ${next}` });
  // Money first: an online or bank-transfer order cannot be accepted (or moved on) until the payment is confirmed as successful.
  if (next !== 'cancelled' && needsPaymentFirst(o)) return res.status(409).json({ error: o.paymentMethod === 'bank_transfer' ? 'Payment has not been confirmed yet. Review the customer\'s transfer proof first.' : 'Payment has not been confirmed yet. You can accept this order once Paystack confirms the payment.' });
  if (o.channel === 'whatsapp' && ['out_for_delivery'].includes(next)) return res.status(402).json({ error: 'Not available for WhatsApp orders' });
  push(o, String(req.user._id), 'status', o.status, next);
  o.status = next; await o.save();
  // Money bookkeeping happens exactly once per order (unique ledger row): completing recognises the commission; cancelling reverses it and frees a booked slot.
  if (next === 'completed') await completeSale(o);
  if (next === 'cancelled') { await reverseSale(o); await releaseSlot(o); }
  if (o.channel === 'checkout' && o.customerEmail)
    sendEmail({ to: o.customerEmail, type: 'order_status', restaurant: o.restaurant, order: o._id, dedupeKey: `status:${o._id}:${next}`,
      subject: `Order ${o.reference}: ${next.replace(/_/g, ' ')}`, body: `<p>Your order is now <b>${escapeHtml(next.replace(/_/g, ' '))}</b>.</p>` });
  res.json(o);
}));

// Ask Paystack right now whether this order's payment went through (useful if the webhook is slow or not set up).
r.post('/:id/recheck-payment', wrap(async (req, res) => {
  const o = await Order.findOne(scope(req, { _id: req.params.id, paymentMethod: 'paystack' }));
  if (!o) return res.status(404).json({ error: 'Not found' });
  const payments = await OrderPayment.find({ order: o._id }).sort('-createdAt').limit(3);
  for (const p of payments) { const v = await verifyOrderPayment(p); if (v.status === 'success') break; }
  res.json(await Order.findById(o._id).select('-trackingTokenHash -idempotencyKey').lean());
}));

// Pay-on-delivery collected (Pro). Never auto-set by order status.
r.post('/:id/pod-collected', requirePro('Pay on delivery'), wrap(async (req, res) => {
  const o = await Order.findOne(scope(req, { _id: req.params.id, paymentMethod: 'pod' }));
  if (!o) return res.status(404).json({ error: 'Not found' });
  if (o.paymentStatus !== 'unpaid_pod') return res.status(400).json({ error: 'Payment is not awaiting collection' });
  push(o, String(req.user._id), 'paymentStatus', o.paymentStatus, 'paid', 'POD collected');
  o.paymentStatus = 'paid'; await o.save();
  await recordSale(o);
  res.json(o);
}));

/* ---------- Bank-transfer proof review ---------- */
// View proof image: owner-scoped, streamed through the API, never a public URL.
r.get('/:id/proof', wrap(async (req, res) => {
  const o = await Order.findOne(scope(req, { _id: req.params.id })).select('_id');
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
  const o = await Order.findOne(scope(req, { _id: req.params.id })).select('_id');
  if (!o) return res.status(404).json({ error: 'Not found' });
  const proof = await PaymentProof.findOne({ order: o._id, restaurant: req.restaurant._id }).sort('-createdAt').select('status reviewNotes reviewedAt createdAt');
  res.json({ proof });
}));

r.post('/:id/proof/review', requirePro('Payment proof review'), validate(z.object({
  decision: z.enum(['accept', 'reject']), notes: z.string().max(300).optional(),
  confirmReceived: z.boolean().optional(),
})), wrap(async (req, res) => {
  const o = await Order.findOne(scope(req, { _id: req.params.id, paymentMethod: 'bank_transfer' }));
  if (!o) return res.status(404).json({ error: 'Not found' });
  const proof = await PaymentProof.findOne({ order: o._id, restaurant: req.restaurant._id, status: 'pending' }).sort('-createdAt');
  if (!proof || o.paymentStatus !== 'awaiting_verification') return res.status(409).json({ error: 'No proof is waiting for review.' });

  if (req.body.decision === 'accept') {
    // The restaurant must explicitly confirm the money actually reached its bank account.
    if (req.body.confirmReceived !== true) return res.status(400).json({ error: 'Confirm that you have checked your bank records and received the money.' });
    proof.status = 'accepted';
    push(o, String(req.user._id), 'paymentStatus', o.paymentStatus, 'paid_manual', 'Proof accepted by restaurant');
    o.paymentStatus = 'paid_manual';
    await o.save(); await recordSale(o);
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

/* ---------- Refunds (owner only) ----------
 * Records a refund the restaurant has made to the customer. The ledger is re-priced from the stored order: commission shrinks in
 * proportion and a full refund removes it entirely. (Ordarly records the refund; the money itself is returned by the restaurant.) */
r.post('/:id/refund', requireOwner, validate(z.object({ amount: z.number().positive().max(100_000_000), reason: z.string().max(200).optional() })), wrap(async (req, res) => {
  const o = await Order.findOne(scope(req, { _id: req.params.id, channel: 'checkout' }));
  if (!o) return res.status(404).json({ error: 'Not found' });
  if (!['paid', 'paid_manual', 'refunded'].includes(o.paymentStatus) && !(o.paymentMethod === 'pod' && o.paymentStatus === 'paid')) return res.status(409).json({ error: 'Only paid orders can be refunded.' });
  const remaining = Math.round((o.total - (o.refundedAmount || 0)) * 100) / 100;
  if (req.body.amount > remaining + 0.001) return res.status(400).json({ error: `You can refund at most ${naira(remaining)} on this order.` });
  const from = o.paymentStatus;
  o.refundedAmount = Math.round(((o.refundedAmount || 0) + req.body.amount) * 100) / 100;
  if (o.refundedAmount >= o.total) o.paymentStatus = 'refunded';
  push(o, String(req.user._id), 'refund', String(o.refundedAmount - req.body.amount), String(o.refundedAmount), req.body.reason || 'Refund recorded');
  if (from !== o.paymentStatus) push(o, String(req.user._id), 'paymentStatus', from, o.paymentStatus, 'Fully refunded');
  await o.save();
  await recordSale(o); // make sure a row exists, then re-price it for the refund
  await applyRefund(o);
  res.json(o);
}));

export default r;
