// Order messages sent to the customer on WhatsApp (only for orders placed on WhatsApp), and staff alerts for chats that need a person.
// Every message is queued once per order+event (dedupeKey), so a repeated Paystack webhook or a double click never sends it twice.
// The confirmation is built from the verified order record and sent only when the order's payment status is really "paid".
import { WhatsAppConversation, WhatsAppMessage, Order, Restaurant } from '../models/index.js';
import { getIntegration } from './whatsappControlsStore.js';
import { enqueue } from './whatsappSender.js';
import * as W from './whatsappPayloads.js';
import { notifyRestaurant } from './notify.js';
import { sendEmail } from './email.js';
import { confirmationText, statusText, EVENTS } from './whatsappMessages.js';
import { formatLocal, tzOf } from './tz.js';

export const STATUS_TEXT = { pending: 'received', accepted: 'accepted', preparing: 'being prepared', ready: 'ready', out_for_delivery: 'on its way', completed: 'complete', cancelled: 'cancelled', awaiting_whatsapp: 'received' };
const LINK_EVENTS = new Set(['paid', 'out_for_delivery']);
const EVENT_OF_STATUS = { accepted: 'accepted', preparing: 'preparing', ready: 'ready', out_for_delivery: 'out_for_delivery', completed: 'completed', cancelled: 'cancelled' };

// Loaded on first use: whatsappOrders pulls in the whole public router, which itself imports the payment code that calls this module.
const trackingLinkFor = async (...a) => (await import('./whatsappOrders.js')).trackingLinkFor(...a);

async function conversationFor(o) {
  return (o.waCustomerId && await WhatsAppConversation.findOne({ restaurant: o.restaurant, customerWaId: o.waCustomerId }))
    || await WhatsAppConversation.findOne({ restaurant: o.restaurant, currentOrderId: o._id })
    || await WhatsAppConversation.findOne({ restaurant: o.restaurant, customerPhone: o.customerPhone });
}

async function build(o, event, integ) {
  const rest = await Restaurant.findById(o.restaurant).select('name slug customDomain timezone').lean();
  const link = LINK_EVENTS.has(event) ? await trackingLinkFor(o, rest) : null;
  if (event === 'paid') {
    const when = o.isScheduled && o.scheduledFor ? formatLocal(o.scheduledFor, tzOf(rest)) : null;
    return { body: confirmationText(o, { restaurantName: rest?.name, link, when }), restaurantName: rest?.name };
  }
  return { body: statusText(event, o, { link }), restaurantName: rest?.name };
}

/** Queues one order message. `resend` makes a new queue entry (used by the dashboard's Resend button); otherwise it is once per order+event. */
async function queue(o, event, { resend = false, user } = {}) {
  const integ = await getIntegration(o.restaurant); if (!integ) return { ok: false, error: 'WhatsApp is not connected.' };
  const conv = await conversationFor(o); if (!conv) return { ok: false, error: 'No WhatsApp conversation found for this customer.' };
  const { body, restaurantName } = await build(o, event, integ); if (!body) return { ok: false, error: 'Nothing to send for this status.' };
  const tpl = integ.templates?.order_update;
  const dedupeKey = resend ? `order:${o._id}:${event}:resend:${Math.floor(Date.now() / 60000)}` : `order:${o._id}:${event}`;
  const m = await enqueue(conv, W.text(body), {
    automated: !resend, origin: resend ? 'staff' : undefined, user, epoch: integ.automationEpoch || 0, dedupeKey, allowDuringHuman: true, category: 'utility', order: o._id, orderEvent: event,
    templateFallback: tpl?.status === 'APPROVED' ? W.template(tpl.name, 'en', [o.reference, restaurantName || 'your restaurant', body.replace(/^[^\w₦]+/, '').replace(/\s+/g, ' ').slice(0, 150)], body) : undefined,
  });
  return { ok: true, message: m };
}

/** Call after an order changes (paid / status / payment_failed). Never throws: a WhatsApp problem must never break the order itself. */
export async function notifyOrderEvent(orderOrId, event) {
  try {
    const ev = EVENT_OF_STATUS[event] || event;
    if (!EVENTS.includes(ev)) return;
    const o = orderOrId?.reference ? orderOrId : await Order.findById(orderOrId).lean();
    if (!o || o.source !== 'whatsapp') return;
    // Only the backend's own payment verification may produce a confirmation.
    if (ev === 'paid' && o.paymentStatus !== 'paid') return;
    if (ev === 'payment_failed' && o.paymentStatus !== 'failed') return;
    const integ = await getIntegration(o.restaurant); if (!integ) return;
    const optional = !['paid', 'payment_failed'].includes(ev);
    if (optional && integ.settings?.notifyStatuses && !integ.settings.notifyStatuses.includes(ev)) return;
    await queue(o.toObject ? o.toObject() : o, ev);
  } catch (e) { console.error('[whatsapp notify]', e.message); }
}

/** Dashboard: send the right message for the order again. Returns { ok, error? }. */
export async function resendOrderNotification(restaurantId, orderId, user) {
  const o = await Order.findOne({ _id: orderId, restaurant: restaurantId, source: 'whatsapp' }).lean();
  if (!o) return { ok: false, error: 'Order not found.' };
  let ev;
  if (o.paymentMethod === 'paystack' && o.paymentStatus !== 'paid') return { ok: false, error: 'Payment has not been confirmed, so there is no confirmation to send.' };
  ev = o.status === 'pending' || o.status === 'awaiting_whatsapp' ? (o.paymentStatus === 'paid' ? 'paid' : 'accepted') : EVENT_OF_STATUS[o.status];
  if (ev === 'accepted' && o.status === 'pending') return { ok: false, error: 'This order has not been accepted yet.' };
  return queue(o, ev, { resend: true, user });
}

const FINAL = { delivered: 'delivered', read: 'delivered', sent: 'sent', failed: 'failed', pending: 'queued' };
/** Dashboard: what happened to each WhatsApp message about this order. "delivered" only when Meta reported delivery, never merely because the send was accepted. */
export async function orderNotificationStatus(restaurantId, orderId) {
  const rows = await WhatsAppMessage.find({ restaurant: restaurantId, order: orderId }).sort('createdAt').select('orderEvent sendStatus deliveryStatus failureReason failureKind attempts createdAt').lean();
  return rows.map((m) => ({
    event: m.orderEvent, at: m.createdAt, attempts: m.attempts || 0,
    state: m.sendStatus === 'cancelled' ? 'failed' : m.sendStatus === 'queued' || m.sendStatus === 'sending' ? 'queued' : FINAL[m.deliveryStatus] || 'sent',
    reason: m.failureReason || undefined,
  }));
}

/** A customer needs a person: push + email to the restaurant (once per conversation per 10 minutes). */
export async function notifyStaffHandover(conv, rest, integ, reason) {
  const last = conv.staffNotifiedAt && Date.now() - new Date(conv.staffNotifiedAt) < 10 * 60000;
  if (last) return;
  await WhatsAppConversation.updateOne({ _id: conv._id }, { staffNotifiedAt: new Date() });
  const who = conv.customerName || (conv.customerPhone ? '+' + conv.customerPhone : 'A customer');
  const n = integ?.settings?.staffNotify || { push: true, email: true };
  if (n.push !== false) notifyRestaurant(rest._id, { title: 'WhatsApp customer needs you', body: `${who}: ${reason}`.slice(0, 140), url: '/dashboard/whatsapp/inbox', tag: `wa-handover-${conv._id}` }).catch(() => {});
  if (n.email !== false) sendEmail({ to: rest.email, type: 'whatsapp_handover', restaurant: rest._id, dedupeKey: `wa-handover:${conv._id}:${Math.floor(Date.now() / 600000)}`, subject: 'A WhatsApp customer needs a reply', body: `<p>${who} needs a person. Reason: ${reason}</p><p>Open <b>WhatsApp → Inbox</b> in your Ordarly dashboard.</p>` }).catch(() => {});
}
