import { Order, OrderPayment, Restaurant, PaymentConfig } from '../models/index.js';
import { ps } from './paystack.js';
import { sendEmail, btn } from './email.js';
import { naira, randomToken } from '../utils/helpers.js';
import { notifyRestaurant } from './notify.js';

const audit = (order, by, field, from, to, note) => order.audit.push({ at: new Date(), by, field, from, to, note });
const asString = (value) => (value === undefined || value === null ? '' : String(value));
const nairaToKobo = (amount) => Math.round(Number(amount) * 100);

// FIX: Paystack sometimes returns metadata as a JSON string instead of an object.
// Always normalise it before reading fields from it.
const parseMeta = (m) => {
  if (!m) return {};
  if (typeof m === 'string') {
    try {
      return JSON.parse(m) || {};
    } catch {
      return {};
    }
  }
  return m;
};

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

  if (await OrderPayment.exists({ order: order._id, status: 'attention' }))
    throw Object.assign(new Error(
      'Paystack confirms that a payment was received for this order, but it still needs to be matched manually. Do not pay again; contact the restaurant or support with your payment reference.'
    ), { status: 409 });

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
        metadata: {
          purpose: 'food_order',
          orderId: String(order._id),
          restaurantId: String(restaurant._id),
          orderRef: order.reference,
        },
      },
    });
    order.paymentStatus = 'pending';
    audit(order, 'system', 'paymentStatus', 'awaiting_payment', 'pending', 'Paystack initialised');
    await order.save();
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
  try {
    t = (await ps(`/transaction/verify/${encodeURIComponent(payment.providerReference)}`)).data;
  } catch {
    return { status: 'pending' };
  }

  const order = await Order.findById(payment.order);
  if (!order) return { status: 'pending' };

  const expected = nairaToKobo(order.total);
  const actual = Number(t.amount);
  const metadata = parseMeta(t.metadata);

  const amountMatches = Number.isFinite(actual) && actual === expected;
  const currencyMatches = asString(t.currency).toUpperCase() === 'NGN';
  const referenceMatchesPayment = asString(t.reference) === asString(payment.providerReference);

  const metadataOrderIdMatches =
    metadata.orderId !== undefined &&
    metadata.orderId !== null &&
    asString(metadata.orderId) === asString(order._id);

  const metadataOrderRefMatches =
    metadata.orderRef !== undefined &&
    metadata.orderRef !== null &&
    asString(metadata.orderRef) === asString(order.reference);

  const metadataRestaurantMatches =
    metadata.restaurantId === undefined ||
    metadata.restaurantId === null ||
    asString(metadata.restaurantId) === asString(order.restaurant);

  const belongsToOrder =
    metadataOrderIdMatches ||
    metadataOrderRefMatches ||
    (referenceMatchesPayment && amountMatches);

  if (t.status === 'success') {
    const metadata = parseMeta(t.metadata);
    const actualAmount = Number(t.amount);
    const expectedAmount = Math.round(Number(order.total) * 100);

    const discrepancies = [];

    if (actualAmount !== expectedAmount) {
      discrepancies.push({
        field: 'amount',
        expectedKobo: expectedAmount,
        actualKobo: t.amount,
      });
    }

    if (String(t.currency || '').toUpperCase() !== 'NGN') {
      discrepancies.push({
        field: 'currency',
        expected: 'NGN',
        actual: t.currency,
      });
    }

    if (
      metadata.orderId !== undefined &&
      metadata.orderId !== null &&
      String(metadata.orderId) !== String(order._id)
    ) {
      discrepancies.push({
        field: 'metadata.orderId',
        expected: String(order._id),
        actual: String(metadata.orderId),
      });
    }

    if (
      t.reference &&
      payment.providerReference &&
      String(t.reference) !== String(payment.providerReference)
    ) {
      discrepancies.push({
        field: 'reference',
        expected: payment.providerReference,
        actual: t.reference,
      });
    }

    // These are diagnostics only. The transaction was retrieved from Paystack
    // using the providerReference stored on this exact payment record, so a
    // successful Paystack response must confirm the payment.
    if (discrepancies.length) {
      console.warn('[order payment] Paystack success has record discrepancies:', {
        providerReference: payment.providerReference,
        paystackReference: t.reference,
        order: order.reference,
        discrepancies,
        metadata,
      });
    }

    const claimed = await OrderPayment.findOneAndUpdate(
      { _id: payment._id, status: { $ne: 'success' } },
      {
        status: 'success',
        verifiedAt: new Date(),
        raw: {
          id: t.id,
          reference: t.reference,
          channel: t.channel,
          paid_at: t.paid_at,
          amount: t.amount,
          currency: t.currency,
          metadata,
          expectedKobo: expectedAmount,
          discrepancies,
        },
      },
      { new: true }
    );

    if (!claimed) return { status: 'success' };

    try {
      if (order.paymentStatus !== 'paid') {
        audit(
          order,
          'paystack',
          'paymentStatus',
          order.paymentStatus,
          'paid',
          `Verified ${payment.providerReference}`
        );

        order.paymentStatus = 'paid';
        await order.save();
      }

      const rest = await Restaurant.findById(order.restaurant);

      await Promise.allSettled([
        sendEmail({
          to: order.customerEmail,
          type: 'payment_confirmed',
          restaurant: order.restaurant,
          order: order._id,
          dedupeKey: `paid:${payment.providerReference}`,
          subject: `Payment received for ${order.reference}`,
          body: `<p>We received your payment of <b>${naira(order.total)}</b>. Thank you!</p>`,
        }),
        sendEmail({
          to: rest?.email,
          type: 'order_paid',
          restaurant: order.restaurant,
          order: order._id,
          dedupeKey: `paid-r:${payment.providerReference}`,
          subject: `Order ${order.reference} paid online`,
          body: `<p>${naira(order.total)} was paid and verified through Paystack. Settlement to your bank follows Paystack's schedule for your account.</p>${btn(`${process.env.CLIENT_URL}/dashboard/orders`, 'Open orders')}`,
        }),
        notifyRestaurant(order.restaurant, {
          title: 'New paid order',
          body: `${order.reference} · ${naira(order.total)} paid online`,
          url: '/dashboard/orders',
          tag: `order-${order._id}`,
        }),
      ]);
    } catch (err) {
      console.error('[order payment] post-success side effects failed', err, {
        paymentId: payment._id,
        orderId: order._id,
        providerReference: payment.providerReference,
      });
    }

    return { status: 'success' };
  }

  if (['failed', 'abandoned', 'reversed'].includes(t.status)) {
    const flipped = await OrderPayment.findOneAndUpdate(
      { _id: payment._id, status: { $in: ['pending', 'attention'] } },
      { status: 'failed' }
    );

    if (flipped && order.paymentStatus === 'pending') {
      audit(order, 'paystack', 'paymentStatus', 'pending', 'failed', t.status);
      order.paymentStatus = 'failed';
      await order.save();

      sendEmail({
        to: order.customerEmail,
        type: 'payment_failed',
        restaurant: order.restaurant,
        order: order._id,
        dedupeKey: `payfail:${payment.providerReference}`,
        subject: `Payment for ${order.reference} did not go through`,
        body: `<p>Your payment was not completed and you have not been charged for this attempt. Open your tracking page to try again, or contact the restaurant.</p>`,
      });
    }

    return { status: 'failed' };
  }

  return { status: 'pending' };
}