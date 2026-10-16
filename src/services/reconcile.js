import { SubscriptionPayment, OrderPayment } from '../models/index.js';
import { verifyOrderPayment } from './orderPayments.js';
import { verifySubscriptionPayment } from '../routes/subscription.js';

/** Safety net for "paid but browser closed" and missed/failed webhooks. Re-verifies recent pending payments with Paystack. */
export async function reconcilePayments() {
  if (!process.env.PAYSTACK_SECRET_KEY) return;
  const from = new Date(Date.now() - 24 * 3600000), to = new Date(Date.now() - 2 * 60000);
  const [subs, orders] = await Promise.all([
    SubscriptionPayment.find({ status: 'pending', createdAt: { $gt: from, $lt: to } }).limit(50),
    OrderPayment.find({
  status: { $in: ['pending', 'failed', 'attention'] },
  createdAt: { $gt: from, $lt: to },
}).limit(100),

  ]);
  for (const p of subs) await verifySubscriptionPayment(p).catch((e) => console.error('[reconcile sub]', e.message));
  for (const p of orders) await verifyOrderPayment(p).catch((e) => console.error('[reconcile order]', e.message));
}
