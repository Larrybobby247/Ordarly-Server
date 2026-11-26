// Ordarly message credits: the arithmetic. Pure functions, no database, unit-tested.
// These credits belong to Ordarly only. They have nothing to do with Meta's own messaging limits or billing.

export const DEFAULT_CREDIT_CONFIG = Object.freeze({
  allowances: { free: 100, pro: 1000, business: 3000 }, // Ordarly's own monthly allowance per plan (editable in the admin dashboard)
  reservationTimeoutHours: 72, // a message that never reaches "delivered" stops holding a credit after this long
  warnAtPercent: [25, 10],
});

export const allowanceFor = (cfg, plan) => {
  const n = Number(cfg?.allowances?.[plan]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : Number(DEFAULT_CREDIT_CONFIG.allowances[plan] ?? 0);
};

/* ---------- billing cycle ---------- */
function addMonths(d, n) { // same day next month, clamped (31 Jan + 1 month = 28/29 Feb)
  const t = new Date(d); const day = t.getUTCDate();
  t.setUTCDate(1); t.setUTCMonth(t.getUTCMonth() + n);
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last)); return t;
}

/**
 * Which credit cycle is `now` in?
 *  - Paying restaurants: anchored on their subscription period start (so credits renew with the subscription). A long period (a yearly
 *    plan) is still split into calendar months from that start, so monthly credits really renew monthly.
 *  - Free restaurants: monthly, anchored on the day the restaurant joined.
 * `id` is what makes allocation idempotent: the same cycle id is never allocated twice.
 */
export function computeCycle({ plan, subscription, restaurantCreatedAt, now = new Date() }) {
  const paidStart = plan !== 'free' && (subscription?.periodStart || subscription?.trialStart);
  const paidEnd = plan !== 'free' && (subscription?.periodEnd || subscription?.trialEnd);
  const anchor = new Date(paidStart || restaurantCreatedAt || now);
  let k = 0;
  while (addMonths(anchor, k + 1) <= now && k < 600) k++;
  const start = addMonths(anchor, k);
  let end = addMonths(anchor, k + 1);
  if (paidEnd && new Date(paidEnd) < end) end = new Date(paidEnd);
  return { id: `${plan === 'free' ? 'free' : 'paid'}:${start.toISOString()}`, start, end };
}

/* ---------- balances ---------- */
export function availability(w) {
  const monthlyRemaining = Math.max(0, (w?.monthlyAllowance || 0) - (w?.monthlyUsed || 0));
  const purchased = Math.max(0, w?.purchasedBalance || 0);
  const reserved = (w?.reservedMonthly || 0) + (w?.reservedPurchased || 0);
  const total = monthlyRemaining + purchased;
  return { monthlyRemaining, purchased, reserved, total, usable: Math.max(0, total - reserved) };
}

/** Monthly credits are used first, then purchased ones. Returns where ONE credit can be held right now, or null when none is free. */
export function pickPool(w) {
  if ((w?.monthlyAllowance || 0) - (w?.monthlyUsed || 0) - (w?.reservedMonthly || 0) > 0) return 'monthly';
  if ((w?.purchasedBalance || 0) - (w?.reservedPurchased || 0) > 0) return 'purchased';
  return null;
}

/** Warning level for the current balance: 'zero' | 'p10' | 'p25' | null. Purchased credits count, so buying more clears the warning. */
export function warningLevel(w, warnAt = DEFAULT_CREDIT_CONFIG.warnAtPercent) {
  const { total } = availability(w);
  if (total <= 0) return 'zero';
  const base = Math.max(w?.monthlyAllowance || 0, 1);
  const [hi, lo] = [...warnAt].sort((a, b) => b - a);
  if (total <= (base * lo) / 100) return 'p10';
  if (total <= (base * hi) / 100) return 'p25';
  return null;
}

/* ---------- purchased packs: which one is used first ---------- */
/**
 * Purchased credits are used oldest pack first. Given the packs (oldest first) and how many purchased credits have been used or expired
 * so far in total, work out what is left in each pack. Used to expire exactly the unused part of a pack.
 */
export function packsRemaining(packs, consumedTotal) {
  let consumed = Math.max(0, consumedTotal || 0);
  return packs.map((p) => { const used = Math.min(p.amount, consumed); consumed -= used; return { ...p, remaining: p.amount - used }; });
}
