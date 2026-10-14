import { Order, OrderPayment, Restaurant, PaymentConfig, User } from '../models/index.js';
import { ps } from './paystack.js';
import { sendEmail, btn } from './email.js';
import { naira, randomToken } from '../utils/helpers.js';
import { notifyRestaurant } from './notify.js';

const audit = (order, by, field, from, to, note) => order.audit.push({ at: new Date(), by, field, from, to, note });

/**
 * Start a Paystack payment for ONE food order.
 * Amount always comes from the stored order total. Funds are routed to the restaurant's subaccount and the
 * restaurant bears Paystack's fee (bearer: 'subaccount'). We do NOT pass transaction_charge, and the
 * subaccount is created with percentage_charge 0, so the platform takes no commission.
 */
export async function startOrderPayment(order, restaurant, callbackUrl) {
  const cfg = await PaymentConfig.findOne({ restaurant: restaurant._id });
  if (!cfg?.subaccountCode || cfg.onboardingStatus !== 'active')
    throw Object.assign(new Error('Online payment is not available for this restaurant right now.'), { status: 409 });
  if (!['awaiting_payment', 'pending', 'failed'].includes(order.paymentStatus) || order.paymentMethod !== 'paystack')
    throw Object.assign(new Error('This order is not awaiting payment.'), { status: 409 });
  if (await OrderPayment.exists({ order: order._id, status: 'success' }))
    throw Object.assign(new Error('This order has already been paid.'), { status: 409 });
  if (!order.customerEmail) throw Object.assign(new Error('Order has no customer email.'), { status: 400 });

  const reference = 'FOD-' + randomToken(10);
  const payment = await OrderPayment.create({
    restaurant: restaurant._id, order: order._id, providerReference: reference, amount: order.total,
  });
  try {
    const { data } = await ps('/transaction/initialize', {
      method: 'POST',
      body: {
        email: order.customerEmail, amount: Math.round(order.total * 100), currency: 'NGN', reference,
        subaccount: cfg.subaccountCode, bearer: 'subaccount',
        callback_url: callbackUrl,
        metadata: { purpose: 'food_order', orderId: String(order._id), restaurantId: String(restaurant._id), orderRef: order.reference },
      },
    });
    order.paymentStatus = 'pending'; audit(order, 'system', 'paymentStatus', 'awaiting_payment', 'pending', 'Paystack initialised'); await order.save();
    return { authorizationUrl: data.authorization_url, reference };
  } catch (e) {
    await OrderPayment.updateOne({ _id: payment._id }, { status: 'failed' });
    throw e;
  }
}

/**
 * Server-side verification via Paystack. The ONLY place a Paystack order becomes "paid".
 * Safe to call repeatedly (webhook + return-page + retries): the success claim is atomic.
 */
export async function verifyOrderPayment(payment) {
  if (payment.status === 'success') return { status: 'success' };
  let t;
  try { t = (await ps(`/transaction/verify/${encodeURIComponent(payment.providerReference)}`)).data; }
  catch { return { status: 'pending' }; } // lookup failure is not a payment failure; do not change state

  const order = await Order.findById(payment.order);
  if (!order) return { status: 'pending' };
  const expected = Math.round(order.total * 100);

  if (t.status === 'success') {
    if (t.amount !== expected || t.currency !== 'NGN' || t.metadata?.orderId !== String(order._id)) {
      await OrderPayment.updateOne({ _id: payment._id }, { status: 'failed', raw: { reason: 'mismatch', amount: t.amount, currency: t.currency } });
      return { status: 'failed', reason: 'mismatch' };
    }
    const claimed = await OrderPayment.findOneAndUpdate(
      { _id: payment._id, status: { $ne: 'success' } },
      { status: 'success', verifiedAt: new Date(), raw: { id: t.id, channel: t.channel, paid_at: t.paid_at } }, { new: true });
    if (!claimed) return { status: 'success' }; // someone else processed it
    audit(order, 'paystack', 'paymentStatus', order.paymentStatus, 'paid', `Verified ${payment.providerReference}`);
    order.paymentStatus = 'paid'; await order.save();
    sendEmail({ to: order.customerEmail, type: 'payment_confirmed', restaurant: order.restaurant, order: order._id,
      dedupeKey: `paid:${payment.providerReference}`, subject: `Payment received for ${order.reference}`,
      body: `<p>We received your payment of <b>${naira(order.total)}</b>. Thank you!</p>` });
    const rest = await Restaurant.findById(order.restaurant);
    sendEmail({ to: rest?.email, type: 'order_paid', restaurant: order.restaurant, order: order._id,
      dedupeKey: `paid-r:${payment.providerReference}`, subject: `Order ${order.reference} paid online`,
      body: `<p>${naira(order.total)} was paid and verified through Paystack. Settlement to your bank follows Paystack's schedule for your account.</p>${btn(`${process.env.CLIENT_URL}/dashboard/orders`, 'Open orders')}` });
    notifyRestaurant(order.restaurant, { title: 'New paid order', body: `${order.reference} · ${naira(order.total)} paid online`, url: '/dashboard/orders', tag: `order-${order._id}` });
    return { status: 'success' };
  }

  if (['failed', 'abandoned', 'reversed'].includes(t.status)) {
    const flipped = await OrderPayment.findOneAndUpdate({ _id: payment._id, status: 'pending' }, { status: 'failed' });
    if (flipped && order.paymentStatus === 'pending') {
      audit(order, 'paystack', 'paymentStatus', 'pending', 'failed', t.status);
      order.paymentStatus = 'failed'; await order.save();
      sendEmail({ to: order.customerEmail, type: 'payment_failed', restaurant: order.restaurant, order: order._id,
        dedupeKey: `payfail:${payment.providerReference}`, subject: `Payment for ${order.reference} did not go through`,
        body: `<p>Your payment was not completed and you have not been charged for this attempt. Open your tracking page to try again, or contact the restaurant.</p>` });
    }
    return { status: 'failed' };
  }
  return { status: 'pending' }; // ongoing / not yet paid
}
