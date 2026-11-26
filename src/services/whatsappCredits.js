// Ordarly message credits: wallet, ledger, reservations and top-ups (the database side; the arithmetic is in whatsappCreditsMath.js).
//
// One successfully DELIVERED outbound message costs exactly one credit:
//   reserve (before sending)  ->  Meta accepts and later reports "delivered"  ->  settle (the credit is really spent)
//                             ->  Meta reports a permanent failure            ->  release (nothing is spent)
// Monthly credits are used before purchased ones. Every state change is a conditional update on one document, so repeated
// webhooks, retries and two workers acting at once can never charge a message twice or release it twice.
import crypto from 'crypto';
import {
  OrdarlyCreditWallet as Wallet, OrdarlyCreditTransaction as Tx, WhatsAppMessageCreditReservation as Reservation, WhatsAppMessage,
  WhatsAppCreditPurchase, WhatsAppCreditPackage, Subscription, Restaurant,
} from '../models/index.js';
import { planOf } from './subscription.js';
import { ps } from './paystack.js';
import { sendEmail } from './email.js';
import { notifyRestaurant } from './notify.js';
import { randomToken, naira } from '../utils/helpers.js';
import { getCreditConfig } from './whatsappConfig.js';
import { allowanceFor, computeCycle, availability, warningLevel, packsRemaining } from './whatsappCreditsMath.js';

const same = (v) => (v === undefined || v === null ? { $exists: false } : v);
const isDup = (e) => e?.code === 11000;
const ownerEmail = async (restaurantId) => (await Restaurant.findById(restaurantId).select('email name').lean()) || {};

/** Writes a ledger row. Rows with a `reference` are unique: a repeated attempt returns { created: false } and changes nothing. */
async function ledger(row) {
  try { return { created: true, tx: await Tx.create(row) }; }
  catch (e) { if (isDup(e)) return { created: false }; throw e; }
}

/* ---------- wallet: creation, monthly allocation, plan changes ---------- */
export async function syncWallet(restaurantId, now = new Date()) {
  const [cfg, sub, rest] = await Promise.all([getCreditConfig(), Subscription.findOne({ restaurant: restaurantId }).lean(), Restaurant.findById(restaurantId).select('createdAt').lean()]);
  const plan = planOf(sub, now);
  const cycle = computeCycle({ plan, subscription: sub, restaurantCreatedAt: rest?.createdAt, now });
  const allowance = allowanceFor(cfg, plan);

  let w = await Wallet.findOne({ restaurant: restaurantId }).lean();
  if (!w) { try { w = (await Wallet.create({ restaurant: restaurantId })).toObject(); } catch (e) { if (!isDup(e)) throw e; w = await Wallet.findOne({ restaurant: restaurantId }).lean(); } }

  if (w.cycleId !== cycle.id) {
    // New cycle: fresh monthly allowance, unused monthly credits are NOT carried over, purchased credits are untouched.
    const before = availability(w).total;
    const upd = await Wallet.findOneAndUpdate({ _id: w._id, cycleId: same(w.cycleId) }, { $set: { cycleId: cycle.id, plan, billingCycleStart: cycle.start, billingCycleEnd: cycle.end, monthlyAllowance: allowance, grantedThisCycle: allowance, monthlyUsed: 0, lastRenewedAt: now } }, { new: true }).lean();
    if (upd) {
      const r = await ledger({ restaurant: restaurantId, transactionType: 'monthly_allocation', amount: allowance, pool: 'monthly', source: 'plan', reference: `monthly:${restaurantId}:${cycle.id}`, description: `${plan} plan monthly credits (unused monthly credits do not roll over)`, previousBalance: before, newBalance: availability(upd).total });
      if (r.created && w.cycleId) notifyEvent(restaurantId, 'renewed', { allowance, plan, cycleId: cycle.id });
      return upd;
    }
    return Wallet.findOne({ restaurant: restaurantId }).lean();
  }
  if (allowance > (w.grantedThisCycle || 0)) {
    // Upgraded mid-cycle: give only the DIFFERENCE, once per level, so switching plans repeatedly can never earn more than the best plan's allowance.
    const diff = allowance - (w.grantedThisCycle || 0);
    const upd = await Wallet.findOneAndUpdate({ _id: w._id, cycleId: cycle.id, grantedThisCycle: w.grantedThisCycle || 0 }, { $inc: { monthlyAllowance: diff }, $set: { grantedThisCycle: allowance, plan } }, { new: true }).lean();
    if (upd) {
      await ledger({ restaurant: restaurantId, transactionType: 'monthly_allocation', amount: diff, pool: 'monthly', source: 'plan_change', reference: `monthly:${restaurantId}:${cycle.id}:to:${allowance}`, description: `Plan upgrade: extra monthly credits for this cycle`, previousBalance: availability(w).total, newBalance: availability(upd).total });
      return upd;
    }
    return Wallet.findOne({ restaurant: restaurantId }).lean();
  }
  return w;
}

/* ---------- reservation, settlement, release ---------- */
const POOL_FILTER = {
  monthly: { $expr: { $gt: [{ $subtract: [{ $subtract: ['$monthlyAllowance', '$monthlyUsed'] }, '$reservedMonthly'] }, 0] } },
  purchased: { $expr: { $gt: [{ $subtract: ['$purchasedBalance', '$reservedPurchased'] }, 0] } },
};
const RESERVED_FIELD = { monthly: 'reservedMonthly', purchased: 'reservedPurchased' };

/** Holds ONE credit for this message (monthly first). Safe to call again for the same message. Resolves { ok, pool } or { ok:false, reason:'credits_exhausted' }. */
export async function reserveCredit(message) {
  await syncWallet(message.restaurant);
  let resv = await Reservation.findOne({ messageId: message._id });
  if (resv?.finalStatus === 'settled') return { ok: true, pool: resv.pool, already: true };
  if (resv?.finalStatus === 'reserved' && resv.pool) return { ok: true, pool: resv.pool };
  if (!resv) {
    try { resv = await Reservation.create({ restaurant: message.restaurant, messageId: message._id }); }
    catch (e) { if (!isDup(e)) throw e; resv = await Reservation.findOne({ messageId: message._id }); if (resv.finalStatus === 'reserved' && resv.pool) return { ok: true, pool: resv.pool }; }
  } else if (resv.finalStatus === 'released') {
    await Reservation.updateOne({ _id: resv._id, finalStatus: 'released' }, { $set: { finalStatus: 'reserved', reservedAt: new Date() }, $unset: { pool: 1, releaseReason: 1 } });
  }
  for (const pool of ['monthly', 'purchased']) {
    const hit = await Wallet.findOneAndUpdate({ restaurant: message.restaurant, ...POOL_FILTER[pool] }, { $inc: { [RESERVED_FIELD[pool]]: 1 } }, { new: true }).lean();
    if (hit) {
      await Reservation.updateOne({ _id: resv._id }, { $set: { pool, finalStatus: 'reserved', reservedAt: new Date() } });
      await WhatsAppMessage.updateOne({ _id: message._id }, { creditReservationId: resv._id });
      return { ok: true, pool };
    }
  }
  await Reservation.deleteOne({ _id: resv._id, pool: { $exists: false } }); // nothing was held
  return { ok: false, reason: 'credits_exhausted' };
}

/** Delivery confirmed: the held credit is spent. Idempotent: a duplicate "delivered"/"read" event finds the reservation already settled and does nothing. */
export async function settleCredit(messageId) {
  let resv = await Reservation.findOneAndUpdate({ messageId, finalStatus: 'reserved', pool: { $exists: true } }, { $set: { finalStatus: 'settled', settledAt: new Date() } }, { new: true });
  if (!resv) {
    // "Delivered" arrived after we gave the credit back because delivery was unconfirmed for too long: take it again if the restaurant still has one.
    const late = await Reservation.findOneAndUpdate({ messageId, finalStatus: 'released', releaseReason: 'timeout' }, { $set: { finalStatus: 'reserved', releaseReason: 'late_delivery' }, $unset: { pool: 1 } }, { new: true });
    if (!late) return { settled: false };
    const msg = await WhatsAppMessage.findById(messageId).select('restaurant').lean();
    const r = await reserveCredit({ _id: messageId, restaurant: msg.restaurant });
    if (!r.ok) { await Reservation.updateOne({ _id: late._id }, { $set: { finalStatus: 'released', releaseReason: 'late_delivery_no_credit' } }); return { settled: false, absorbed: true }; }
    return settleCredit(messageId);
  }
  const msg = await WhatsAppMessage.findById(messageId).select('restaurant').lean();
  const restaurant = resv.restaurant || msg?.restaurant;
  const before = availability(await Wallet.findOne({ restaurant }).lean()).total;
  const r = await ledger({ restaurant, transactionType: 'message_deduction', amount: -1, pool: resv.pool, source: 'whatsapp_message', reference: `msg:${messageId}`, messageId, description: 'Delivered WhatsApp message', previousBalance: before, newBalance: Math.max(0, before - 1) });
  if (!r.created) return { settled: true, duplicate: true };
  try {
    const inc = resv.pool === 'monthly' ? { reservedMonthly: -1, monthlyUsed: 1 } : { reservedPurchased: -1, purchasedBalance: -1, purchasedConsumed: 1 };
    const w = await Wallet.findOneAndUpdate({ restaurant }, { $inc: inc }, { new: true }).lean();
    await Reservation.updateOne({ _id: resv._id }, { transactionId: r.tx._id });
    await WhatsAppMessage.updateOne({ _id: messageId }, { creditCharged: true });
    maybeWarn(restaurant, w).catch(() => {});
    return { settled: true };
  } catch (e) {
    await Tx.deleteOne({ _id: r.tx._id }); await Reservation.updateOne({ _id: resv._id }, { $set: { finalStatus: 'reserved' } }); // undo so a retry can finish the job
    throw e;
  }
}

/** The message did not (and now cannot) arrive: give the held credit back. Idempotent. */
export async function releaseCredit(messageId, reason = 'failed') {
  const resv = await Reservation.findOneAndUpdate({ messageId, finalStatus: 'reserved' }, { $set: { finalStatus: 'released', releaseReason: reason, settledAt: new Date() } });
  if (!resv) return { released: false };
  if (resv.pool) await Wallet.updateOne({ restaurant: resv.restaurant }, { $inc: { [RESERVED_FIELD[resv.pool]]: -1 } });
  return { released: true };
}

/** Housekeeping: credits held for messages whose delivery was never confirmed are returned after the configured time (72h by default). */
export async function releaseStaleReservations(now = new Date()) {
  const cfg = await getCreditConfig();
  const cutoff = new Date(now - cfg.reservationTimeoutHours * 3600000);
  const stale = await Reservation.find({ finalStatus: 'reserved', reservedAt: { $lt: cutoff } }).limit(200).lean();
  for (const r of stale) {
    const m = await WhatsAppMessage.findById(r.messageId).select('sendStatus').lean();
    if (m && ['queued', 'sending'].includes(m.sendStatus)) continue; // still being worked on
    const out = await releaseCredit(r.messageId, 'timeout');
    if (out.released) await WhatsAppMessage.updateOne({ _id: r.messageId, deliveryStatus: { $in: ['pending', 'sent'] } }, { deliveryStatus: 'unconfirmed' });
  }
  await Reservation.deleteMany({ pool: { $exists: false }, createdAt: { $lt: new Date(now - 600000) } }); // empty holds from a crashed attempt
  return stale.length;
}

/* ---------- views ---------- */
export async function walletSummary(restaurantId) {
  const [w, cfg] = await Promise.all([syncWallet(restaurantId), getCreditConfig()]);
  const a = availability(w);
  const nextExpiry = await Tx.findOne({ restaurant: restaurantId, transactionType: 'topup_purchase', expiresAt: { $gt: new Date() }, expiryProcessed: false }).sort('expiresAt').select('expiresAt amount').lean();
  return {
    plan: w.plan, monthlyAllowance: w.monthlyAllowance, monthlyUsed: w.monthlyUsed, monthlyRemaining: a.monthlyRemaining,
    purchasedBalance: a.purchased, totalAvailable: a.total, reserved: a.reserved,
    cycleStart: w.billingCycleStart, nextRenewal: w.billingCycleEnd,
    level: warningLevel(w, cfg.warnAtPercent), // 'zero' | 'p10' | 'p25' | null: drives the in-dashboard warning
    nextPurchasedExpiry: nextExpiry ? { at: nextExpiry.expiresAt } : null,
  };
}

/* ---------- warnings and notices ---------- */
async function notifyEvent(restaurantId, event, data = {}) {
  const { email, name } = await ownerEmail(restaurantId);
  const copy = {
    p25: ['WhatsApp credits running low', 'About 25% of your Ordarly message credits are left.'],
    p10: ['WhatsApp credits almost finished', 'Only about 10% of your Ordarly message credits are left.'],
    zero: ['WhatsApp credits finished', 'Your Ordarly message credits are finished, so automated WhatsApp replies are paused. Customer messages are still received and saved. Buy more credits to switch replies back on.'],
    renewed: ['WhatsApp monthly credits renewed', `Your ${data.allowance} monthly Ordarly message credits have been added.`],
    purchased: ['WhatsApp credits added', `${data.credits} Ordarly message credits were added to your account.`],
  }[event];
  if (!copy) return;
  const key = `wa-credit:${event}:${restaurantId}:${data.cycleId || data.reference || ''}`;
  await Promise.allSettled([
    sendEmail({ to: email, type: 'whatsapp_credits', restaurant: restaurantId, dedupeKey: key, subject: copy[0], body: `<p>Hi ${name || ''},</p><p>${copy[1]}</p><p>Open <b>WhatsApp → Usage &amp; Billing</b> in your Ordarly dashboard to see your balance${event === 'zero' || event === 'p10' || event === 'p25' ? ' or buy more credits' : ''}.</p>` }),
    notifyRestaurant(restaurantId, { title: copy[0], body: copy[1], url: '/dashboard/whatsapp/billing', tag: `wa-credit-${event}` }),
  ]);
}

/** Sends each low-balance warning once per cycle (25%, 10%, zero). Buying credits re-arms them for the next time. */
export async function maybeWarn(restaurantId, wallet) {
  const cfg = await getCreditConfig();
  const level = warningLevel(wallet, cfg.warnAtPercent);
  if (!level) return;
  const slot = level === 'zero' ? 'zero' : level === 'p10' ? 'p10' : 'p25';
  const claimed = await Wallet.findOneAndUpdate({ _id: wallet._id, [`warned.${slot}`]: { $ne: wallet.cycleId } }, { $set: { [`warned.${slot}`]: wallet.cycleId } });
  if (claimed) await notifyEvent(restaurantId, slot, { cycleId: wallet.cycleId });
}

/* ---------- top-ups (Paystack, paid to Ordarly's own account, like subscriptions) ---------- */
export async function startPurchase(restaurant, packageId) {
  const pkg = await WhatsAppCreditPackage.findOne({ _id: packageId, active: true }).lean();
  if (!pkg || !(pkg.price > 0)) throw Object.assign(new Error('That credit package is not available right now.'), { status: 404 });
  const reference = 'WAC-' + randomToken(10);
  const purchase = await WhatsAppCreditPurchase.create({ restaurant: restaurant._id, package: pkg._id, packageName: pkg.name, credits: pkg.credits, amount: pkg.price, expiryDays: pkg.expiryDays ?? undefined, providerReference: reference });
  try {
    const { data } = await ps('/transaction/initialize', { method: 'POST', body: {
      email: restaurant.email, amount: Math.round(pkg.price * 100), currency: 'NGN', reference,
      callback_url: `${process.env.CLIENT_URL || ''}/dashboard/whatsapp/billing?reference=${reference}`,
      metadata: { purpose: 'whatsapp_credits', restaurantId: String(restaurant._id), purchaseId: String(purchase._id), credits: pkg.credits },
    } });
    return { authorizationUrl: data.authorization_url, reference };
  } catch (e) { await WhatsAppCreditPurchase.updateOne({ _id: purchase._id }, { status: 'failed' }); throw e; }
}

/**
 * The ONLY place purchased credits are added after a payment. Never called from a browser "success" message: it asks Paystack directly and
 * checks the reference, amount, currency, purpose and restaurant. Safe to call from the webhook, the return page and the reconcile job together.
 */
export async function verifyPurchase(purchase) {
  if (purchase.status === 'success') return { status: 'success' };
  let t;
  try { t = (await ps(`/transaction/verify/${encodeURIComponent(purchase.providerReference)}`)).data; } catch { return { status: 'pending' }; }
  if (['failed', 'abandoned', 'reversed'].includes(t.status)) { await WhatsAppCreditPurchase.updateOne({ _id: purchase._id, status: 'pending' }, { status: 'failed' }); return { status: 'failed' }; }
  if (t.status !== 'success') return { status: 'pending' };

  let meta = t.metadata; if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = {}; } }
  const problems = [];
  if (String(t.reference) !== purchase.providerReference) problems.push('reference');
  if (Number(t.amount) !== Math.round(purchase.amount * 100)) problems.push('amount');
  if (String(t.currency || '').toUpperCase() !== 'NGN') problems.push('currency');
  if (meta?.purpose !== 'whatsapp_credits') problems.push('purpose');
  if (String(meta?.restaurantId) !== String(purchase.restaurant)) problems.push('restaurant');
  if (problems.length) { // money arrived but does not match this purchase: never grant credits automatically
    console.error('[whatsapp credits] payment does not match purchase', purchase.providerReference, problems);
    await WhatsAppCreditPurchase.updateOne({ _id: purchase._id }, { $set: { raw: { mismatch: problems, amount: t.amount, currency: t.currency } } });
    return { status: 'attention', problems };
  }
  const claimed = await WhatsAppCreditPurchase.findOneAndUpdate({ _id: purchase._id, status: { $ne: 'success' } }, { $set: { status: 'success', verifiedAt: new Date(), raw: { id: t.id, paid_at: t.paid_at, channel: t.channel } } }, { new: true });
  if (!claimed) return { status: 'success' };
  await grantPurchase(claimed);
  return { status: 'success' };
}

async function grantPurchase(p) {
  const w0 = await syncWallet(p.restaurant);
  const before = availability(w0).total;
  const r = await ledger({ restaurant: p.restaurant, transactionType: 'topup_purchase', amount: p.credits, pool: 'purchased', source: 'paystack', reference: `topup:${p.providerReference}`, paymentReference: p.providerReference, description: `${p.packageName} pack (${p.credits} credits)`, previousBalance: before, newBalance: before + p.credits, expiresAt: p.expiryDays ? new Date(Date.now() + p.expiryDays * 86400000) : undefined });
  if (!r.created) return;
  try {
    const w = await Wallet.findOneAndUpdate({ restaurant: p.restaurant }, { $inc: { purchasedBalance: p.credits, purchasedGranted: p.credits } }, { new: true }).lean();
    notifyEvent(p.restaurant, 'purchased', { credits: p.credits, reference: p.providerReference });
    return w;
  } catch (e) { await Tx.deleteOne({ _id: r.tx._id }); await WhatsAppCreditPurchase.updateOne({ _id: p._id }, { status: 'pending' }); throw e; } // undo so the next verify can finish
}

/** Pending purchases (webhook missed, customer closed the tab): ask Paystack again. Runs from the minute job. */
export async function reconcilePurchases(now = new Date()) {
  const rows = await WhatsAppCreditPurchase.find({ status: 'pending', createdAt: { $lt: new Date(now - 2 * 60000), $gt: new Date(now - 48 * 3600000) } }).limit(30);
  for (const p of rows) await verifyPurchase(p).catch((e) => console.error('[whatsapp credits] reconcile', e.message));
}

/* ---------- administrator adjustments ---------- */
export async function adminAdjust({ restaurantId, amount, pool, reason, admin }) {
  if (!Number.isInteger(amount) || amount === 0) throw Object.assign(new Error('Enter a whole number of credits (not 0).'), { status: 400 });
  const w = await syncWallet(restaurantId);
  const before = availability(w).total;
  let upd;
  if (pool === 'monthly') {
    const floor = (w.monthlyUsed || 0) + (w.reservedMonthly || 0);
    upd = await Wallet.findOneAndUpdate({ _id: w._id, monthlyAllowance: w.monthlyAllowance, ...(amount < 0 ? { $expr: { $gte: [{ $add: ['$monthlyAllowance', amount] }, { $add: ['$monthlyUsed', '$reservedMonthly'] }] } } : {}) }, { $inc: { monthlyAllowance: amount } }, { new: true }).lean();
    if (!upd) throw Object.assign(new Error(`Cannot remove that many monthly credits (at least ${floor} are already used or held).`), { status: 409 });
  } else {
    upd = await Wallet.findOneAndUpdate({ _id: w._id, ...(amount < 0 ? { $expr: { $gte: [{ $add: ['$purchasedBalance', amount] }, '$reservedPurchased'] } } : {}) }, { $inc: amount > 0 ? { purchasedBalance: amount, purchasedGranted: amount } : { purchasedBalance: amount, purchasedConsumed: -amount } }, { new: true }).lean();
    if (!upd) throw Object.assign(new Error('Cannot remove more purchased credits than the restaurant has free.'), { status: 409 });
  }
  const after = availability(upd).total;
  await Tx.create({ restaurant: restaurantId, transactionType: 'admin_adjustment', amount, pool, source: 'admin', reference: `adj:${crypto.randomUUID()}`, description: reason, reason, adminId: admin._id, adminName: admin.name || admin.email, previousBalance: before, newBalance: after });
  return { previousBalance: before, newBalance: after };
}

/* ---------- purchased-credit expiry (only when a pack was sold with an expiry) ---------- */
export async function expirePurchasedCredits(now = new Date()) {
  const due = await Tx.find({ transactionType: 'topup_purchase', expiresAt: { $lte: now }, expiryProcessed: false }).sort('createdAt').limit(100).lean();
  for (const t of due) {
    const claimed = await Tx.findOneAndUpdate({ _id: t._id, expiryProcessed: false }, { $set: { expiryProcessed: true } });
    if (!claimed) continue;
    const w = await Wallet.findOne({ restaurant: t.restaurant }).lean();
    if (!w) continue;
    // Packs are used oldest first, so what is left of THIS pack follows from how many purchased credits have been used or expired so far.
    const packs = await Tx.find({ restaurant: t.restaurant, $or: [{ transactionType: 'topup_purchase' }, { transactionType: 'admin_adjustment', pool: 'purchased', amount: { $gt: 0 } }] }).sort('createdAt').select('amount').lean();
    const left = packsRemaining(packs.map((p) => ({ id: String(p._id), amount: p.amount })), w.purchasedConsumed).find((p) => p.id === String(t._id))?.remaining || 0;
    const expire = Math.min(left, Math.max(0, (w.purchasedBalance || 0) - (w.reservedPurchased || 0)));
    if (expire <= 0) continue;
    const before = availability(w).total;
    const r = await ledger({ restaurant: t.restaurant, transactionType: 'credit_expiry', amount: -expire, pool: 'purchased', source: 'expiry', reference: `expiry:${t._id}`, description: `Unused credits from the ${t.description || 'purchased'} pack expired`, previousBalance: before, newBalance: before - expire });
    if (r.created) await Wallet.updateOne({ restaurant: t.restaurant }, { $inc: { purchasedBalance: -expire, purchasedConsumed: expire } });
  }
}

/** Renews monthly credits (and sends the "renewed" notice) for every connected restaurant without waiting for it to send a message. Hourly. */
export async function renewAllWallets() {
  const { WhatsAppIntegration } = await import('../models/index.js');
  const rows = await WhatsAppIntegration.find({ connectionStatus: { $nin: ['not_connected'] } }).select('restaurant').lean();
  for (const r of rows) await syncWallet(r.restaurant).catch((e) => console.error('[whatsapp credits] renew', e.message));
}
