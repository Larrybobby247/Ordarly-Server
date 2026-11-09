// The money ledger. One LedgerEntry per order, enforced by a unique index, so commission can be booked at most once no matter
// how many times a webhook is retried, a status is changed or an endpoint is called.
import { LedgerEntry, Order, PlatformSetting } from '../models/index.js';
import { computeSale } from './earningsMath.js';

const PAID = ['paid', 'paid_manual'];

/** Create the entry when an order's money is confirmed. Safe to call any number of times. */
export async function recordSale(order, { gatewayFeeKobo, plan } = {}) {
  const pct = order.commissionPct || 0;
  const s = computeSale({ mealSubtotal: order.subtotal || 0, deliveryFee: order.deliveryFee || 0, commissionPct: pct });
  const charged = order.paymentMethod === 'paystack' ? order.commissionAmount || 0 : 0; // only a Paystack payment can carry the split
  try {
    await LedgerEntry.updateOne({ order: order._id }, {
      $setOnInsert: {
        restaurant: order.restaurant, branch: order.branch || null, order: order._id, orderRef: order.reference, status: 'held', plan, paymentMethod: order.paymentMethod,
        mealSubtotal: order.subtotal || 0, deliveryFee: order.deliveryFee || 0, commissionPct: pct, commission: s.commission, commissionCharged: charged,
        net: s.net, eventAt: new Date(),
      },
    }, { upsert: true });
  } catch (e) { if (e?.code !== 11000) throw e; } // lost a race with another caller: the entry exists, which is all we wanted
  if (Number.isFinite(gatewayFeeKobo)) await LedgerEntry.updateOne({ order: order._id, gatewayFee: null }, { $set: { gatewayFee: gatewayFeeKobo / 100 } });
}

/** Order completed: the sale becomes earned (commission recognised). Only the first call changes anything. */
export async function completeSale(order) {
  if (order.refundedAmount >= order.total && order.total > 0) return reverseSale(order);
  await recordSale(order);
  const now = new Date();
  await LedgerEntry.updateOne({ order: order._id, status: 'held' }, { $set: { status: 'earned', completedAt: now, eventAt: now } });
}

/** Cancelled or fully refunded: no commission, nothing earned; any commission already taken by the split is flagged to be returned. */
export async function reverseSale(order) {
  const e = await LedgerEntry.findOne({ order: order._id });
  if (!e || e.status === 'reversed') return;
  await LedgerEntry.updateOne({ _id: e._id, status: e.status }, {
    $set: { status: 'reversed', commission: 0, net: 0, refunded: (order.subtotal || 0) + (order.deliveryFee || 0), commissionReturnDue: e.commissionCharged, reversedAt: new Date() },
  });
}

/** Re-price an entry after a (partial) refund. Commission shrinks in proportion; a full refund reverses the sale. */
export async function applyRefund(order) {
  const e = await LedgerEntry.findOne({ order: order._id });
  if (!e) return;
  const s = computeSale({ mealSubtotal: e.mealSubtotal, deliveryFee: e.deliveryFee, commissionPct: e.commissionPct, refunded: order.refundedAmount || 0 });
  if (s.fullyRefunded) return reverseSale(order);
  await LedgerEntry.updateOne({ _id: e._id, status: { $ne: 'reversed' } }, {
    $set: { refunded: order.refundedAmount || 0, commission: s.commission, net: s.net, commissionReturnDue: Math.max(0, Math.round((e.commissionCharged - s.commission) * 100) / 100) },
  });
}

/* ---------- Reports ---------- */
const money = (n) => Math.round((n || 0) * 100) / 100;

/** Totals for a restaurant (optionally limited to branches and a date range). All numbers come from ledger rows. */
export async function earningsSummary({ restaurant, branchMatch = {}, range }) {
  const base = { restaurant, ...branchMatch };
  const when = range ? { eventAt: { $gte: range.from, $lt: range.to } } : {};
  const sum = (field) => ({ $sum: `$${field}` });
  const [earned, refunds, pending, owed, byBranch] = await Promise.all([
    LedgerEntry.aggregate([{ $match: { ...base, ...when, status: 'earned' } }, { $group: { _id: null, orders: { $sum: 1 }, meals: sum('mealSubtotal'), delivery: sum('deliveryFee'), commission: sum('commission'), gateway: sum('gatewayFee'), net: sum('net'), refunded: sum('refunded') } }]),
    LedgerEntry.aggregate([{ $match: { ...base, ...when, status: { $in: ['earned', 'reversed'] }, refunded: { $gt: 0 } } }, { $group: { _id: null, refunded: sum('refunded'), n: { $sum: 1 } } }]),
    LedgerEntry.aggregate([{ $match: { ...base, status: 'held' } }, { $group: { _id: null, orders: { $sum: 1 }, net: sum('net'), commission: sum('commission') } }]),
    LedgerEntry.aggregate([{ $match: { ...base, commissionReturnDue: { $gt: 0 }, commissionReturnedAt: null } }, { $group: { _id: null, due: sum('commissionReturnDue') } }]),
    LedgerEntry.aggregate([{ $match: { ...base, ...when, status: 'earned' } }, { $group: { _id: '$branch', orders: { $sum: 1 }, meals: sum('mealSubtotal'), delivery: sum('deliveryFee'), commission: sum('commission'), net: sum('net') } }]),
  ]);
  const e = earned[0] || {};
  return {
    completedOrders: e.orders || 0, mealSales: money(e.meals), deliveryFees: money(e.delivery), commission: money(e.commission),
    gatewayFees: money(e.gateway), refunds: money(refunds[0]?.refunded), netEarnings: money(e.net),
    netAfterGatewayFees: money((e.net || 0) - (e.gateway || 0)),
    pendingSettlement: { orders: pending[0]?.orders || 0, net: money(pending[0]?.net), commission: money(pending[0]?.commission) },
    commissionToReturn: money(owed[0]?.due),
    byBranch: byBranch.map((b) => ({ branch: b._id, orders: b.orders, mealSales: money(b.meals), deliveryFees: money(b.delivery), commission: money(b.commission), netEarnings: money(b.net) })),
  };
}

/** One-time: give every already-completed order a ledger row with 0% commission, so history appears in the new reports without charging anyone retroactively. */
export async function backfillLedger() {
  if (await PlatformSetting.findOne({ key: 'ledger_backfill_v1' }).lean()) return { skipped: true };
  let last = null, made = 0;
  for (;;) {
    const q = { status: 'completed', channel: 'checkout', ...(last ? { _id: { $gt: last } } : {}) };
    const batch = await Order.find(q).sort('_id').limit(500).select('_id restaurant branch reference subtotal deliveryFee total paymentMethod updatedAt').lean();
    if (!batch.length) break;
    last = batch.at(-1)._id;
    const have = new Set((await LedgerEntry.find({ order: { $in: batch.map((o) => o._id) } }).select('order').lean()).map((x) => String(x.order)));
    const docs = batch.filter((o) => !have.has(String(o._id))).map((o) => ({
      restaurant: o.restaurant, branch: o.branch || null, order: o._id, orderRef: o.reference, status: 'earned', paymentMethod: o.paymentMethod,
      mealSubtotal: o.subtotal || 0, deliveryFee: o.deliveryFee || 0, commissionPct: 0, commission: 0, net: money((o.subtotal || 0) + (o.deliveryFee || 0)),
      eventAt: o.updatedAt, completedAt: o.updatedAt, legacy: true,
    }));
    if (docs.length) { try { await LedgerEntry.insertMany(docs, { ordered: false }); made += docs.length; } catch (e) { if (e?.code !== 11000 && !e?.writeErrors) throw e; } }
  }
  await PlatformSetting.updateOne({ key: 'ledger_backfill_v1' }, { value: { at: new Date(), made } }, { upsert: true });
  if (made) console.log(`[ledger] backfilled ${made} completed order(s) at 0% commission`);
  return { made };
}
