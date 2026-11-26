// Customer-facing order messages (pure: no database). Every value comes from the verified order record passed in; nothing is invented.
// An estimated time is only mentioned when the order carries a real one (scheduled orders); otherwise the line is simply left out.
import { displayPhone } from './whatsappCustomer.js';

const money = (n) => '₦' + Number(n || 0).toLocaleString('en-NG');
const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

export const EVENTS = ['paid', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled', 'payment_failed'];

function itemLines(o) {
  return (o.items || []).map((i) => `• ${i.quantity}x ${i.name}${i.size ? ` (${i.size})` : ''}${i.addons?.length ? ` + ${i.addons.map((a) => a.name || a).join(', ')}` : ''}`);
}

/** Order confirmation, sent once after Paystack has verified the payment. */
export function confirmationText(o, { restaurantName, link, when } = {}) {
  const delivery = o.fulfillment === 'delivery';
  const lines = [
    `Hello ${first(o.customerName)}! 🎉`, '',
    'Your payment has been confirmed and your order has been received successfully.', '',
    '📋 ORDER CONFIRMATION', '',
    `Restaurant: ${restaurantName || 'Your restaurant'}`,
    `Order Reference: ${o.reference}`,
    `Order Type: ${delivery ? 'Delivery' : 'Pickup'}`,
    ...(when ? [`Scheduled for: ${when}`] : []), '',
    'YOUR ORDER:', ...itemLines(o), '',
    `Food Subtotal: ${money(o.subtotal)}`,
    ...(delivery ? [`Delivery Fee: ${money(o.deliveryFee)}`] : []),
    `Total Paid: ${money(o.total)}`, '',
    'Payment Status: Successful', '',
    "We're now processing your order.",
    ...(link ? ['', '📍 Track your order here:', link] : []), '',
    'Thank you for ordering with us!',
  ];
  return lines.join('\n');
}

/** One status update. `link` is added only where the customer benefits from it. */
export function statusText(event, o, { link } = {}) {
  const n = first(o.customerName), ref = o.reference;
  switch (event) {
    case 'accepted': return `Good news, ${n}! Your order ${ref} has been accepted by the restaurant.`;
    case 'preparing': return `Your order ${ref} is now being prepared. We'll notify you when it is ready.`;
    case 'ready': return o.fulfillment === 'delivery'
      ? `Your order ${ref} is ready and waiting for dispatch. We'll tell you when it is on its way.`
      : `Your order ${ref} is ready for pickup. You can visit the restaurant to collect it.`;
    case 'out_for_delivery': return `Your order ${ref} is on its way! 🛵${link ? ` You can follow its progress here: ${link}` : ''}`;
    case 'completed': return o.fulfillment === 'delivery'
      ? `Your order ${ref} has been marked as delivered. Thank you for choosing us!`
      : `Your order ${ref} has been marked as collected. Thank you for choosing us!`;
    case 'cancelled': return `Your order ${ref} has been cancelled. Please contact the restaurant if you need assistance.`;
    case 'payment_failed': return `Your payment for order ${ref} did not go through, so the order is not confirmed. You can try again from the payment link, or type HUMAN for help.`;
    default: return null;
  }
}

/** Plain-language status for "track my order". Honest about payment: a pending payment is never described as an order in progress. */
export function trackStatusText(o) {
  if (o.paymentMethod === 'paystack' && o.paymentStatus !== 'paid') {
    if (o.paymentStatus === 'failed') return 'payment failed, not confirmed yet';
    return 'waiting for payment, not confirmed yet';
  }
  const m = {
    pending: 'received, waiting for the restaurant to accept', awaiting_whatsapp: 'received, waiting for the restaurant to accept',
    accepted: 'accepted by the restaurant', preparing: 'being prepared',
    ready: o.fulfillment === 'delivery' ? 'ready, waiting for dispatch' : 'ready for pickup',
    out_for_delivery: 'on its way', completed: o.fulfillment === 'delivery' ? 'delivered' : 'collected', cancelled: 'cancelled',
  };
  return m[o.status] || String(o.status || 'received').replace(/_/g, ' ');
}

export const ACTIVE_STATUSES = ['pending', 'awaiting_whatsapp', 'accepted', 'preparing', 'ready', 'out_for_delivery'];

export { displayPhone };
