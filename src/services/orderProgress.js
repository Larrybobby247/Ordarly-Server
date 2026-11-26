// Customer-facing order progress (pure). Built ONLY from the order record and its audit trail, so the tracking page, the dashboard and the
// WhatsApp messages always agree. A stage is "done" only when the matching backend event really happened; nothing is assumed in advance.
const FLOW = ['accepted', 'preparing', 'ready', 'out_for_delivery', 'completed'];
const needsPayment = (o) => ['paystack', 'bank_transfer'].includes(o.paymentMethod);

export function buildProgress(o) {
  const audit = o.audit || [];
  const delivery = o.fulfillment === 'delivery';
  const paid = o.paymentStatus === 'paid';
  const cancelled = o.status === 'cancelled';
  const confirmed = !needsPayment(o) || paid;
  const when = (field, to) => audit.find((a) => a.field === field && a.to === to)?.at || null;
  const flow = delivery ? FLOW : FLOW.filter((s) => s !== 'out_for_delivery');
  const label = { accepted: 'Order accepted', preparing: 'Preparing', ready: delivery ? 'Awaiting dispatch' : 'Ready for pickup', out_for_delivery: 'Out for delivery', completed: delivery ? 'Delivered' : 'Collected' };

  const stages = [];
  if (needsPayment(o)) stages.push({ key: 'payment', label: 'Payment confirmed', state: paid ? 'done' : 'current', at: paid ? when('paymentStatus', 'paid') : null });
  stages.push({ key: 'received', label: 'Order received', state: confirmed ? 'done' : 'upcoming', at: confirmed ? (when('paymentStatus', 'paid') || o.createdAt || null) : null });

  const reached = (s) => o.status === s || !!when('status', s);
  const rank = (s) => flow.indexOf(s);
  const furthest = Math.max(-1, ...flow.filter(reached).map(rank));
  let currentSet = !confirmed || cancelled;
  for (const s of flow) {
    const isDone = reached(s);
    let state = isDone ? 'done' : rank(s) < furthest ? 'skipped' : 'upcoming';
    if (state === 'upcoming' && !currentSet) { state = 'current'; currentSet = true; }
    stages.push({ key: s, label: label[s], state, at: when('status', s) });
  }
  if (cancelled) {
    const kept = stages.filter((x) => x.state === 'done');
    kept.push({ key: 'cancelled', label: 'Cancelled', state: 'done', at: when('status', 'cancelled') });
    return { stages: kept, message: 'This order was cancelled. Please contact the restaurant if you need help.', cancelled: true, paymentConfirmed: paid };
  }
  const visible = stages.filter((x) => x.state !== 'skipped');
  let message;
  if (needsPayment(o) && !paid) message = o.paymentStatus === 'failed' ? 'Your payment did not go through, so the order is not confirmed. You can try again.' : o.paymentStatus === 'awaiting_verification' ? 'The restaurant is checking your transfer. Your order is not confirmed until payment is verified.' : 'Waiting for your payment. Your order is not confirmed until payment is verified.';
  else if (o.status === 'completed') message = delivery ? 'Your order has been delivered.' : 'Your order has been collected.';
  else if (o.status === 'out_for_delivery') message = 'Your order is on its way.';
  else if (o.status === 'ready') message = delivery ? 'Your order is ready and waiting for dispatch.' : 'Your order is ready for pickup.';
  else if (o.status === 'preparing') message = 'Your order is being prepared.';
  else if (o.status === 'accepted') message = 'The restaurant has accepted your order. Waiting for the restaurant to update it.';
  else message = 'Waiting for the restaurant to update your order.';
  return { stages: visible, message, cancelled: false, paymentConfirmed: paid };
}
