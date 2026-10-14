import { Router } from 'express';
import multer from 'multer';
import { Order, OrderPayment, PaymentProof, Restaurant, Subscription } from '../models/index.js';
import { wrap, sha256, naira } from '../utils/helpers.js';
import { isProActive } from '../services/subscription.js';
import { startOrderPayment, verifyOrderPayment } from '../services/orderPayments.js';
import { sniffImage, saveProof } from '../services/storage.js';
import { sendEmail, btn } from '../services/email.js';
import { notifyRestaurant } from '../services/notify.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

async function orderByToken(token) {
  const order = await Order.findOne({ trackingTokenHash: sha256(String(token)) });
  return order;
}

/* Pay online: amount comes from the stored order, never from the browser. */
r.post('/track/:token/pay', wrap(async (req, res) => {
  const order = await orderByToken(req.params.token);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const [rest, sub] = await Promise.all([Restaurant.findById(order.restaurant), Subscription.findOne({ restaurant: order.restaurant })]);
  if (!rest || rest.status !== 'active') return res.status(409).json({ error: 'Restaurant unavailable' });
  if (!isProActive(sub))
    return res.status(409).json({ error: 'Online payment is not available for this restaurant right now.' });
  try {
    const out = await startOrderPayment(order, rest, `${process.env.CLIENT_URL}/track/${req.params.token}?pay=1`);
    res.json(out);
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
}));

// Customer returns from Paystack: verify with Paystack, not the URL.
r.post('/track/:token/verify-payment', wrap(async (req, res) => {
  const order = await orderByToken(req.params.token);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const payments = await OrderPayment.find({ order: order._id }).sort('-createdAt').limit(3);
  let result = { status: order.paymentStatus === 'paid' ? 'success' : 'pending' };
  for (const p of payments) { const v = await verifyOrderPayment(p); if (v.status === 'success') { result = v; break; } result = v; }
  res.json(result);
}));

/* Bank-transfer proof upload. NEVER marks the order paid. */
r.post('/track/:token/proof', upload.single('proof'), wrap(async (req, res) => {
  const order = await orderByToken(req.params.token);
  if (!order || order.paymentMethod !== 'bank_transfer') return res.status(404).json({ error: 'Order not found' });
  if (!['awaiting_payment', 'rejected', 'awaiting_verification'].includes(order.paymentStatus))
    return res.status(409).json({ error: 'This order is not waiting for a payment proof.' });
  if (order.status === 'cancelled') return res.status(409).json({ error: 'This order was cancelled.' });
  if (!req.file) return res.status(400).json({ error: 'Choose an image (JPG, PNG or WebP, max 5 MB).' });
  const kind = sniffImage(req.file.buffer);
  if (!kind) return res.status(400).json({ error: 'Only JPG, PNG or WebP images are accepted.' });
  if ((await PaymentProof.countDocuments({ order: order._id })) >= 5) return res.status(429).json({ error: 'Too many proof uploads for this order.' });

  const fileRef = await saveProof(req.file.buffer, kind.ext);
  await PaymentProof.updateMany({ order: order._id, status: 'pending' }, { status: 'rejected', reviewNotes: 'Superseded by a newer upload' });
  await PaymentProof.create({ order: order._id, restaurant: order.restaurant, fileRef });
  order.audit.push({ at: new Date(), by: 'customer', field: 'paymentStatus', from: order.paymentStatus, to: 'awaiting_verification', note: 'Proof uploaded' });
  order.paymentStatus = 'awaiting_verification'; await order.save();

  const rest = await Restaurant.findById(order.restaurant);
  sendEmail({ to: order.customerEmail, type: 'proof_received', restaurant: order.restaurant, order: order._id,
    dedupeKey: `proofrec:${order._id}:${fileRef}`, subject: `We received your payment proof for ${order.reference}`,
    body: `<p>Thanks. ${rest?.name} will check their bank records and confirm. This is <b>not</b> a payment confirmation yet.</p>` });
  sendEmail({ to: rest?.email, type: 'proof_submitted', restaurant: order.restaurant, order: order._id,
    dedupeKey: `proofsub:${order._id}:${fileRef}`, subject: `Payment proof submitted for ${order.reference}`,
    body: `<p>${order.customerName} says they transferred <b>${naira(order.total)}</b>. Check your bank records before accepting.</p>${btn(`${process.env.CLIENT_URL}/dashboard/orders`, 'Review proof')}` });
  notifyRestaurant(order.restaurant, { title: 'Payment proof to review', body: `${order.reference} · ${naira(order.total)} bank transfer`, url: '/dashboard/orders', tag: `order-${order._id}` });
  res.status(201).json({ paymentStatus: 'awaiting_verification' });
}));

export default r;
