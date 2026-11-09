// Commission and earnings maths. Pure and unit-tested. All money is naira, rounded to kobo.
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Ordarly commission = MEAL SUBTOTAL x pct. Delivery fees never attract commission. */
export const commissionOf = (mealSubtotal, pct) => r2((Math.max(0, Number(mealSubtotal) || 0) * Math.max(0, Number(pct) || 0)) / 100);

/**
 * One order's money.
 *   Restaurant Net = Meal Subtotal - Commission + Delivery Fee            (before separate gateway fees)
 * Refunds are proportional: refunding x% of what the customer paid gives back x% of the commission as well,
 * so the restaurant keeps (1 - x) of everything and a full refund means no commission at all.
 */
export function computeSale({ mealSubtotal = 0, deliveryFee = 0, commissionPct = 0, refunded = 0 } = {}) {
  const total = r2(mealSubtotal + deliveryFee);
  const baseCommission = commissionOf(mealSubtotal, commissionPct);
  const ratio = total > 0 ? Math.min(1, Math.max(0, refunded / total)) : 0;
  const commission = r2(baseCommission * (1 - ratio));
  const net = r2(total * (1 - ratio) - commission);
  return { total, baseCommission, commission, refundRatio: ratio, fullyRefunded: ratio >= 1, net: Math.max(0, net), commissionReleased: r2(baseCommission - commission) };
}

/** What Paystack's split should send to Ordarly for an order (kobo), or 0 when no commission applies. */
export const commissionKobo = (mealSubtotal, pct) => Math.round(commissionOf(mealSubtotal, pct) * 100);
