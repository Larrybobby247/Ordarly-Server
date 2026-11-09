// Central plan defaults. Live values are stored in PlatformSetting (admin-editable);
// these are only used to seed the database on first boot.
export const DEFAULT_PLAN_CONFIG = {
  free: {
    maxActiveMeals: 10,        // admin-editable; clear it in Admin > Platform settings to allow unlimited meals
    commissionPct: 5,          // % of the MEAL SUBTOTAL only (never delivery) on each completed online-paid order
    features: ['checkout', 'paystack', 'delivery', 'pickup', 'dine_in', 'tracking', 'analytics', 'whatsapp_orders', 'basic_dashboard'],
  },
  pro: {
    priceNgn: 7500,
    periodDays: 30,
    yearlyDiscountPct: 5, // paying for 12 months up front is this % cheaper than 12 monthly payments
    commissionPct: 0,
    maxActiveMeals: null, // unlimited
    features: [
      'checkout', 'paystack', 'bank_transfer', 'pay_on_delivery', 'delivery',
      'pickup', 'dine_in', 'tracking', 'qr_code', 'analytics', 'customization',
      'custom_domain', 'emails',
    ],
  },
  // Multi-branch plan. Price and branch limit are NOT decided in code: the plan stays closed ("Contact us") until an admin
  // sets a price and a branch limit in Admin > Plans and switches it on.
  business: {
    enabled: false,
    priceNgn: 0,
    periodDays: 30,
    yearlyDiscountPct: 5,
    commissionPct: 0,
    maxBranches: 0,
    maxActiveMeals: null,
    features: ['multi_branch', 'staff_roles', 'branch_analytics', 'combined_reports'],
  },
};

export const PLAN_KEYS = ['free', 'pro', 'business'];
/** Plans that are paid (and therefore unlock every Pro feature). */
export const PAID_PLANS = ['pro', 'business'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
/** Layer stored settings over the defaults so newly introduced fields always have a value. */
export function mergePlanConfig(stored = {}, defaults = DEFAULT_PLAN_CONFIG) {
  const out = {};
  for (const k of new Set([...Object.keys(defaults), ...Object.keys(stored || {})])) {
    out[k] = isObj(defaults[k]) && isObj(stored?.[k]) ? mergePlanConfig(stored[k], defaults[k]) : (stored?.[k] !== undefined ? stored[k] : defaults[k]);
  }
  return out;
}

/** Commission % that applies to a restaurant on `plan`. Always read from the live plan config, never from the client. */
export const commissionPctFor = (cfg, plan) => {
  const v = Number(cfg?.[plan]?.commissionPct);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 0;
};

export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'login', 'register', 'signup', 'dashboard', 'about', 'faq', 'contact',
  'terms', 'privacy', 'pricing', 'how-it-works', 'track', 'verify-email', 'reset-password',
  'forgot-password', 'assets', 'static', 'app', 'www', 'help', 'support', 'blog',
  // reserved because every restaurant can also be reached at <slug>.<platform domain>
  'mail', 'smtp', 'ftp', 'status', 'staging', 'dev', 'test', 'cdn', 'docs', 'accept-invite', 'ns1', 'ns2', 'webmail', 'billing',
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
export function yearlyQuote(cfg, plan = 'pro') {
  const monthly = cfg[plan].priceNgn;
  const pct = cfg[plan].yearlyDiscountPct ?? DEFAULT_PLAN_CONFIG.pro.yearlyDiscountPct;
  const full = monthly * 12;
  const price = Math.round(full * (1 - pct / 100));
  return { price, discountPct: pct, fullPrice: full, savings: full - price, monthlyEquivalent: Math.round(price / 12), periodDays: YEARLY_PERIOD_DAYS };
}
