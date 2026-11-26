// Turns a finished WhatsApp conversation into a normal Ordarly order. It re-uses the website's own code for everything that involves money:
// prices from the menu (priceCart), delivery fee from the delivery engine (quoteDelivery), the commission snapshot, and Paystack (startOrderPayment).
// Nothing a customer typed is trusted: the cart is re-priced and the delivery address re-quoted here, at the moment the order is created.
import { Restaurant, Subscription, PaymentConfig, Order } from '../models/index.js';
import { findRestaurant, branchContext, priceCart, isOpenNow } from '../routes/public.js';
import { effectiveRestaurant } from './branches.js';
import { quoteDelivery, deliveryConfigured } from './delivery.js';
import { validPlaceId } from './places.js';
import { planOf } from './subscription.js';
import { getPlanConfig } from './settings.js';
import { commissionPctFor } from '../config/plans.js';
import { commissionOf } from './earningsMath.js';
import { startOrderPayment } from './orderPayments.js';
import { sendEmail, btn } from './email.js';
import { notifyRestaurant } from './notify.js';
import { canCreateOrder, getIntegration } from './whatsappControlsStore.js';
import { orderRef, randomToken, sha256, naira } from '../utils/helpers.js';
import { encryptToken, decryptToken } from './tokenVault.js';
import { publicBaseFor } from './customDomain.js';
import { validName, cleanPhone } from './whatsappCustomer.js';

/** Everything the conversation needs to know about the restaurant (and branch), read fresh from the database. */
export async function loadContext(restaurantId, branchId) {
  const rest = await Restaurant.findById(restaurantId);
  if (!rest || rest.status !== 'active') return null;
  const subscription = await Subscription.findOne({ restaurant: rest._id }).lean();
  const plan = planOf(subscription), isPro = plan !== 'free';
  const found = { rest, isPro, plan };
  const ctx = await branchContext(found, branchId);
  const er = effectiveRestaurant(rest, ctx.branch);
  const cfg = await PaymentConfig.findOne({ restaurant: rest._id }).select('onboardingStatus');
  return { rest, er, isPro, plan, ctx, branchId: ctx.branch?._id || null, paystackReady: !!(rest.payments?.paystackEnabled && cfg?.onboardingStatus === 'active'), isOpen: isOpenNow(er) };
}

export function methodsFor(c, settings = {}, fulfillment) {
  const out = [];
  if (c.paystackReady && settings.allowOnlinePayment !== false) out.push('online');
  if (c.isPro && c.rest.payments?.podEnabled && fulfillment === 'delivery' && settings.allowPayOnDelivery !== false) out.push('pod');
  return out;
}
export function fulfilmentFor(c, settings = {}) {
  const f = c.er.fulfillment || {};
  return {
    delivery: !!(f.deliveryEnabled && f.location?.lat != null && deliveryConfigured() && settings.allowDelivery !== false),
    pickup: !!(f.pickupEnabled && settings.allowPickup !== false),
  };
}

const payerEmail = (waId) => `wa.${String(waId).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 40)}@${process.env.WHATSAPP_PAYER_EMAIL_DOMAIN || 'ordarly.com.ng'}`;

/** Creates the order. Resolves { ok:true, orderId, reference, total, paymentUrl? } or { ok:false, error } (a message safe to show the customer). */
export async function createWhatsAppOrder({ conv, method }) {
  const guard = await canCreateOrder(conv.restaurant);
  if (!guard.ok) return { ok: false, error: 'Sorry, we are not taking WhatsApp orders right now.' };
  const integ = await getIntegration(conv.restaurant);
  const settings = integ?.settings || {};
  const c = await loadContext(conv.restaurant, conv.branchId);
  if (!c) return { ok: false, error: 'This restaurant is not available right now.' };
  if (c.ctx.error || c.ctx.required) return { ok: false, error: 'Please order on our website to choose a branch.' };
  if (!c.isOpen) return { ok: false, error: 'Sorry, we are closed right now.' };

  const key = `wa:${conv._id}:${conv.cartVersion}`;
  const dup = await Order.findOne({ restaurant: c.rest._id, idempotencyKey: key }).select('+trackingTokenEnc');
  if (dup) return { ok: true, orderId: dup._id, reference: dup.reference, total: dup.total, duplicate: true, trackingUrl: await trackingLinkFor(dup, c.rest) };

  const fulfillment = conv.fulfillment;
  // Never create an order with missing or invalid customer details (the engine collects them first; this is the server-side guard).
  const name = validName(conv.confirmedName);
  const phone = cleanPhone(conv.contactPhone || conv.customerPhone);
  if (!name || !phone || !conv.phoneConfirmed) return { ok: false, error: 'We still need your name and phone number before we can place the order.' };
  if (fulfillment === 'delivery' && !String(conv.delivery?.details || '').trim()) return { ok: false, error: 'Please tell us your delivery address details first.' };
  if (!fulfilmentFor(c, settings)[fulfillment]) return { ok: false, error: `Sorry, ${fulfillment} is not available.` };
  if (!methodsFor(c, settings, fulfillment).includes(method)) return { ok: false, error: 'That payment option is not available.' };

  const { items, unavailable, subtotal } = await priceCart(c.rest, conv.currentCart || [], c.branchId);
  if (!items.length || unavailable.length) return { ok: false, error: 'Some items are no longer available. Please check your cart.' };

  let deliveryFee = 0, deliveryPlace, deliveryDistanceKm, deliveryLocation;
  if (fulfillment === 'delivery') {
    if (!validPlaceId(conv.delivery?.placeId)) return { ok: false, error: 'Please share your delivery address again.' };
    let q;
    try { q = await quoteDelivery(c.er, conv.delivery.placeId); } catch (e) { return { ok: false, error: e.status < 500 ? e.message : 'We could not work out the delivery price. Please try again.' }; }
    if (!q.ok) return { ok: false, error: `Sorry, that address is outside our delivery range (${q.rules.maxRadiusKm} km).` };
    deliveryFee = q.fee; deliveryPlace = q.place.address; deliveryDistanceKm = q.distanceKm; deliveryLocation = { lat: q.place.lat, lng: q.place.lng };
  }

  const paymentMethod = method === 'online' ? 'paystack' : 'pod';
  const planCfg = await getPlanConfig();
  const commissionPct = paymentMethod === 'paystack' ? commissionPctFor(planCfg, c.plan) : 0; // same rule as the website checkout: meal subtotal only
  const token = randomToken(24);
  const order = await Order.create({
    restaurant: c.rest._id, reference: orderRef(), channel: 'checkout', source: 'whatsapp', trackingTokenHash: sha256(token), trackingTokenEnc: encryptToken(token), waCustomerId: conv.customerWaId,
    branch: c.branchId, branchName: c.ctx.branch?.name, commissionPct, commissionAmount: commissionOf(subtotal, commissionPct),
    customerName: name, customerEmail: payerEmail(conv.customerWaId), customerPhone: phone,
    items, subtotal, deliveryFee, total: subtotal + deliveryFee, fulfillment, deliveryPlace, deliveryDistanceKm, deliveryLocation,
    deliveryAddress: fulfillment === 'delivery' ? (conv.delivery?.details || deliveryPlace) : undefined,
    paymentMethod, paymentStatus: paymentMethod === 'paystack' ? 'awaiting_payment' : 'unpaid_pod', status: 'pending', idempotencyKey: key,
    notes: 'Ordered on WhatsApp',
  });

  const trackBase = await publicBaseFor({}, c.rest, c.isPro);
  let paymentUrl;
  if (paymentMethod === 'paystack') {
    try { paymentUrl = (await startOrderPayment(order, c.rest, `${trackBase}/track/${token}?pay=1`)).authorizationUrl; }
    catch (e) { console.error('[whatsapp order] payment start failed', e.message); return { ok: false, error: 'We could not start the payment. Please try again, or type HUMAN.' }; }
  } else {
    sendEmail({ to: c.rest.email, type: 'new_order', restaurant: c.rest._id, order: order._id, dedupeKey: `new:${order._id}`, subject: `New WhatsApp order ${order.reference}`, body: `<p>${naira(order.total)} via ${fulfillment} (pay on delivery).</p>${btn(`${process.env.CLIENT_URL}/dashboard/orders`, 'Open orders')}` });
    notifyRestaurant(c.rest._id, { title: 'New WhatsApp order', body: `${order.reference} · ${naira(order.total)} (pay on delivery)`, url: '/dashboard/orders', tag: `order-${order._id}` });
  }
  return { ok: true, orderId: order._id, reference: order.reference, total: order.total, paymentUrl, trackingUrl: `${trackBase}/track/${token}` };
}

/** Order list filter: ?source=website|whatsapp. Old orders have no `source` and count as website orders. */
export function orderSourceFilter(source) {
  if (source === 'whatsapp') return { source: 'whatsapp' };
  if (source === 'website') return { source: { $ne: 'whatsapp' }, channel: { $ne: 'whatsapp' } };
  return {};
}

/** The customer's tracking link, rebuilt from the stored (encrypted) token and the restaurant's public domain. null when it cannot be built (old order, key missing). */
export async function trackingLinkFor(order, rest) {
  try {
    const o = order.trackingTokenEnc ? order : await Order.findById(order._id).select('+trackingTokenEnc').lean();
    if (!o?.trackingTokenEnc) return null;
    const token = decryptToken(o.trackingTokenEnc); if (!token) return null;
    const r = rest || await Restaurant.findById(o.restaurant);
    if (!r) return null;
    const sub = await Subscription.findOne({ restaurant: r._id }).lean();
    const base = await publicBaseFor({}, r, planOf(sub) !== 'free');
    return `${base}/track/${token}`;
  } catch { return null; }
}
