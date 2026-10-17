import { Subscription, Restaurant, User, SubscriptionPayment } from '../models/index.js';
import { getPlanConfig } from './settings.js';
import { sendEmail, btn } from './email.js';

const DAY = 86400000;
const clientUrl = () => process.env.CLIENT_URL || '';

export async function ensureSubscription(restaurantId) {
  let sub = await Subscription.findOne({ restaurant: restaurantId });
  if (!sub) {
    sub = await Subscription.create({ restaurant: restaurantId });
    await Restaurant.updateOne({ _id: restaurantId }, { subscription: sub._id, plan: 'free' });
  }
  return sub;
}

export function isProActive(sub, now = new Date()) {
  if (!sub) return false;
  if (sub.status === 'trialing') return sub.trialEnd && sub.trialEnd > now;
  if (sub.status === 'active') return sub.periodEnd && sub.periodEnd > now;
  return false;
}

async function ownerOf(restaurantId) {
  const r = await Restaurant.findById(restaurantId).lean();
  const u = r && (await User.findById(r.owner).lean());
  return { r, u };
}

export async function startTrial(restaurantId) {
  const cfg = await getPlanConfig();
  const sub = await ensureSubscription(restaurantId);
  if (sub.trialUsed) throw Object.assign(new Error('Trial already used'), { status: 409 });
  if (isProActive(sub)) throw Object.assign(new Error('Pro already active'), { status: 409 });
  const now = new Date();
  sub.plan = 'pro'; sub.status = 'trialing'; sub.trialUsed = true;
  sub.trialStart = now; sub.trialEnd = new Date(+now + cfg.pro.trialDays * DAY);
  sub.remindersSent = {};
  await sub.save();
  await Restaurant.updateOne({ _id: restaurantId }, { plan: 'pro' });
  const { r, u } = await ownerOf(restaurantId);
  await sendEmail({
    to: u?.email, type: 'trial_started', restaurant: restaurantId,
    dedupeKey: `trial_started:${sub._id}`,
    subject: 'Your 14-day Pro trial has started',
    body: `<p>Hi ${u?.name}, Pro is now active for <b>${r?.name}</b> until ${sub.trialEnd.toDateString()}.</p>${btn(clientUrl() + '/dashboard/subscription', 'View subscription')}`,
  });
  return sub;
}

/** Called ONLY after server-side Paystack verification. Idempotent per payment reference.
 *  Accepts either a pending paymentDoc (will try to claim) OR an already-claimed document.
 */
export async function activateFromPayment(paymentDoc) {
  const cfg = await getPlanConfig();

  // If caller passed an already-claimed/success doc, proceed to finish activation.
  if (paymentDoc && paymentDoc.status === 'success') {
    try {
      return await finishActivation(paymentDoc, cfg);
    } catch (e) {
      // Record activation error but keep payment success so webhook/client isn't affected.
      console.error('[subscription] finishActivation failed for already-claimed payment', { paymentId: paymentDoc._id, err: e });
      try {
        await SubscriptionPayment.updateOne(
          { _id: paymentDoc._id },
          { $set: { activationError: e?.message || String(e), activationErrorAt: new Date() } }
        );
      } catch (uerr) {
        console.error('[subscription] failed to persist activation error', uerr);
      }
      return paymentDoc;
    }
  }

  // Atomic claim: only the first caller flips pending -> success
  const claimed = await SubscriptionPayment.findOneAndUpdate(
    { _id: paymentDoc._id, status: { $ne: 'success' } },
    { status: 'success', verifiedAt: new Date() }, { new: true }
  );
  if (!claimed) {
    // Already processed concurrently by another worker; try to load that version and finish activation
    const existing = await SubscriptionPayment.findById(paymentDoc._id).lean();
    if (existing && existing.status === 'success') {
      try {
        return await finishActivation(existing, cfg);
      } catch (e) {
        console.error('[subscription] finishActivation failed for concurrently-claimed payment', { paymentId: paymentDoc._id, err: e });
        try {
          await SubscriptionPayment.updateOne(
            { _id: paymentDoc._id },
            { $set: { activationError: e?.message || String(e), activationErrorAt: new Date() } }
          );
        } catch (uerr) {
          console.error('[subscription] failed to persist activation error', uerr);
        }
        return existing;
      }
    }
    return null; // nothing to do
  }

  // We have claimed the payment; try to finish activation.
  try {
    return await finishActivation(claimed, cfg);
  } catch (e) {
    // Do NOT revert payment to pending. Record activation error and keep payment marked success.
    console.error('[subscription] activation failed after payment marked success', { paymentId: claimed._id, err: e });
    try {
      await SubscriptionPayment.updateOne(
        { _id: claimed._id },
        { $set: { activationError: e?.message || String(e), activationErrorAt: new Date() } }
      );
    } catch (uerr) {
      console.error('[subscription] failed to record activation error on payment', uerr);
    }
    return claimed;
  }
}

async function finishActivation(claimed, cfg) {
  const sub = await ensureSubscription(claimed.restaurant);
  const now = new Date();
  const base = isProActive(sub, now) && sub.status === 'active' && sub.periodEnd > now ? sub.periodEnd : now;
  sub.plan = 'pro'; sub.status = 'active';
  sub.periodStart = sub.periodStart && base > now ? sub.periodStart : now;
  sub.periodEnd = new Date(+base + cfg.pro.periodDays * DAY);
  sub.lastPaymentReference = claimed.providerReference;
  sub.remindersSent = {};
  await sub.save();
  await Restaurant.updateOne({ _id: claimed.restaurant }, { plan: 'pro' });
  const { r, u } = await ownerOf(claimed.restaurant);
  // Not awaited: don't let email provider failures block activation
  sendEmail({
    to: u?.email, type: 'subscription_paid', restaurant: claimed.restaurant,
    dedupeKey: `sub_paid:${claimed.providerReference}`,
    subject: 'Pro subscription confirmed',
    body: `<p>Payment received for <b>${r?.name}</b>. Pro is active until ${sub.periodEnd.toDateString()}.</p>`,
  }).catch((e) => console.error('[subscription] sendEmail failed', e));
  return sub;
}

/** Cron: reminders + automatic downgrade. Does not depend on dashboard visits. */
export async function runSubscriptionSweep() {
  const now = new Date();
  const subs = await Subscription.find({ status: { $in: ['trialing', 'active'] } });
  for (const sub of subs) {
    const end = sub.status === 'trialing' ? sub.trialEnd : sub.periodEnd;
    if (!end) continue;
    const { r, u } = await ownerOf(sub.restaurant);
    const left = end - now;
    const rs = sub.remindersSent || {};

    if (left <= 0) {
      // Grace: don't downgrade if a payment for this restaurant is still pending verification (<2h old)
      const pending = await SubscriptionPayment.exists({
        restaurant: sub.restaurant, status: 'pending', createdAt: { $gt: new Date(+now - 2 * 3600000) },
      });
      if (pending) continue;
      sub.status = 'expired'; sub.plan = 'free';
      sub.remindersSent = { ...rs, expired: true };
      await sub.save();
      await Restaurant.updateOne({ _id: sub.restaurant }, { plan: 'free' });
      await sendEmail({
        to: u?.email, type: 'pro_expired', restaurant: sub.restaurant,
        dedupeKey: `pro_expired:${sub._id}:${+end}`,
        subject: 'Your Pro plan has expired',
        body: `<p>${r?.name} is now on the Free plan. Your data is safe. Subscribe to restore Pro features.</p>${btn(clientUrl() + '/dashboard/subscription', 'Subscribe')}`,
      });
    } else if (left <= 1 * DAY && !rs.d1) {
      sub.remindersSent = { ...rs, d1: true }; await sub.save();
      await sendEmail({ to: u?.email, type: 'pro_reminder_1d', restaurant: sub.restaurant,
        dedupeKey: `rem1:${sub._id}:${+end}`, subject: 'Pro ends in 1 day',
        body: `<p>Your Pro access for ${r?.name} ends ${end.toDateString()}.</p>${btn(clientUrl() + '/dashboard/subscription', 'Subscribe now')}` });
    } else if (left <= 3 * DAY && !rs.d3) {
      sub.remindersSent = { ...rs, d3: true }; await sub.save();
      await sendEmail({ to: u?.email, type: 'pro_reminder_3d', restaurant: sub.restaurant,
        dedupeKey: `rem3:${sub._id}:${+end}`, subject: 'Pro ends in 3 days',
        body: `<p>Your Pro access for ${r?.name} ends ${end.toDateString()}.</p>${btn(clientUrl() + '/dashboard/subscription', 'Subscribe now')}` });
    }
  }
}

/** Support tool: give a restaurant N days of Pro without a payment. Always audited by the caller. */
export async function adminGrantPro(restaurantId, days) {
  const sub = await ensureSubscription(restaurantId);
  const now = new Date();
  const base = sub.status === 'active' && sub.periodEnd > now ? sub.periodEnd : now;
  sub.plan = 'pro'; sub.status = 'active';
  sub.periodStart = sub.periodStart && base > now ? sub.periodStart : now;
  sub.periodEnd = new Date(+base + days * DAY);
  sub.lastPaymentReference = 'ADMIN-GRANT'; sub.remindersSent = {};
  await sub.save();
  await Restaurant.updateOne({ _id: restaurantId }, { plan: 'pro' });
  const { r, u } = await ownerOf(restaurantId);
  await sendEmail({ to: u?.email, type: 'pro_granted', restaurant: restaurantId, dedupeKey: `grant:${sub._id}:${+sub.periodEnd}`,
    subject: 'Pro access added to your restaurant',
    body: `<p>${r?.name} has Pro access until ${sub.periodEnd.toDateString()}.</p>` });
  return sub;
}

export async function adminRevokePro(restaurantId) {
  const sub = await ensureSubscription(restaurantId);
  sub.plan = 'free'; sub.status = 'expired'; sub.remindersSent = { ...(sub.remindersSent || {}), expired: true };
  await sub.save();
  await Restaurant.updateOne({ _id: restaurantId }, { plan: 'free' });
  return sub;
}