// Central plan defaults. Live values are stored in PlatformSetting (admin-editable);
// these are only used to seed the database on first boot.
export const DEFAULT_PLAN_CONFIG = {
  free: { maxActiveMeals: 10, features: ['whatsapp_orders', 'basic_dashboard'] },
  pro: {
    priceNgn: 7500,
    periodDays: 30,
    yearlyDiscountPct: 5, // paying for 12 months up front is this % cheaper than 12 monthly payments
    trialDays: 14,
    maxActiveMeals: null, // unlimited
    features: [
      'checkout', 'paystack', 'bank_transfer', 'pay_on_delivery', 'delivery',
      'pickup', 'dine_in', 'tracking', 'qr_code', 'analytics', 'customization',
      'custom_domain', 'emails',
    ],
  },
};

export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'login', 'register', 'signup', 'dashboard', 'about', 'faq', 'contact',
  'terms', 'privacy', 'pricing', 'how-it-works', 'track', 'verify-email', 'reset-password',
  'forgot-password', 'assets', 'static', 'app', 'www', 'help', 'support', 'blog',
]);

export const NIGERIAN_STATES = [
  'Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa','Benue','Borno','Cross River',
  'Delta','Ebonyi','Edo','Ekiti','Enugu','FCT','Gombe','Imo','Jigawa','Kaduna','Kano',
  'Katsina','Kebbi','Kogi','Kwara','Lagos','Nasarawa','Niger','Ogun','Ondo','Osun','Oyo',
  'Plateau','Rivers','Sokoto','Taraba','Yobe','Zamfara',
];

export const ORDER_STATUSES = [
  'awaiting_whatsapp', 'pending', 'accepted', 'preparing', 'ready',
  'out_for_delivery', 'completed', 'cancelled',
];

export const PAYMENT_STATUSES = [
  'not_required', 'pending', 'awaiting_payment', 'awaiting_verification',
  'paid', 'paid_manual', 'unpaid_pod', 'failed', 'rejected', 'refunded',
];

// Valid order-status transitions
// An order the restaurant can act on right now: no payment needed first (WhatsApp, pay on delivery) or the money is confirmed.
export const PAID_STATES = ['paid', 'paid_manual'];
export const needsPaymentFirst = (o) => o.channel === 'checkout' && ['paystack', 'bank_transfer'].includes(o.paymentMethod) && !PAID_STATES.includes(o.paymentStatus);
export const ACTIONABLE = { $or: [{ paymentMethod: { $in: ['none', 'pod'] } }, { paymentStatus: { $in: PAID_STATES } }] };

export const ORDER_TRANSITIONS = {
  awaiting_whatsapp: ['accepted', 'cancelled'],
  pending: ['accepted', 'cancelled'],
  accepted: ['preparing', 'ready', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['out_for_delivery', 'completed', 'cancelled'],
  out_for_delivery: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const YEARLY_PERIOD_DAYS = 365;

/** Yearly price = 12 months minus the discount, rounded to a whole naira. Always computed on the server from the live monthly price. */
export function yearlyQuote(cfg) {
  const monthly = cfg.pro.priceNgn;
  const pct = cfg.pro.yearlyDiscountPct ?? DEFAULT_PLAN_CONFIG.pro.yearlyDiscountPct;
  const full = monthly * 12;
  const price = Math.round(full * (1 - pct / 100));
  return { price, discountPct: pct, fullPrice: full, savings: full - price, monthlyEquivalent: Math.round(price / 12), periodDays: YEARLY_PERIOD_DAYS };
}
