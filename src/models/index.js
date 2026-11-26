import mongoose from 'mongoose';
const { Schema } = mongoose;
const oid = (ref, extra = {}) => ({ type: Schema.Types.ObjectId, ref, ...extra });

export const User = mongoose.model('User', new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['owner', 'admin', 'staff'], default: 'owner' }, // 'staff' = invited employee/manager (no restaurant of their own)
  emailVerified: { type: Boolean, default: false },
  verifyTokenHash: { type: String, select: false },
  resetTokenHash: { type: String, select: false },
  resetExpires: { type: Date, select: false },
  suspendReason: String,
  lastLoginAt: Date,
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
}, { timestamps: true }));

export const Restaurant = mongoose.model('Restaurant', new Schema({
  owner: oid('User', { required: true, index: true }),
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, lowercase: true },
  customDomain: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
  // Lifecycle: none -> pending_dns -> verifying -> verified (ownership proven) -> configuring (Vercel routing/SSL) -> active.
  // 'failed' is terminal until the owner retries. Legacy records only ever held none/pending_dns/verified.
  customDomainStatus: { type: String, enum: ['none', 'pending_dns', 'verifying', 'verified', 'configuring', 'active', 'failed'], default: 'none', index: true },
  customDomainToken: { type: String },
  customDomainMeta: {
    vercelProjectId: String,                 // project the domain was registered with
    isApex: Boolean,
    apexName: String,
    ownershipVerified: { type: Boolean, default: false },   // our _orderly-verify TXT record was found
    ownershipVerifiedAt: Date,
    vercelVerified: { type: Boolean, default: false },      // Vercel accepted its own verification challenge
    vercelChallenge: { type: [new Schema({ type: { type: String }, domain: String, value: String, reason: String }, { _id: false })], default: [] },
    dnsConfigured: { type: Boolean, default: false },       // Vercel reports the domain routes to it (misconfigured === false)
    configuredBy: String,                    // CNAME | A | http | dns-01 as reported by Vercel
    recommended: { type: [new Schema({ type: { type: String }, host: String, hostLabel: String, value: String, purpose: String, note: String }, { _id: false })], default: [] },
    sslReady: { type: Boolean, default: false },
    createdAt: Date,
    activatedAt: Date,
    lastCheckedAt: Date,
    nextCheckAt: Date,                       // background worker only looks at domains whose time has come
    checkAttempts: { type: Number, default: 0 },
    lastError: String,
    lastErrorCode: String,
    legacy: { type: Boolean, default: false }, // verified before the Vercel integration existed; kept serving until re-checked
  },
  description: { type: String, default: '' },
  logo: String,
  cover: String,
  phone: String,
  email: String,
  whatsapp: String, // digits with country code, e.g. 2348012345678
  address: String,
  state: String,
  openingHours: { type: [{ day: Number, open: String, close: String, closed: Boolean }], default: [] },
  acceptingOrders: { type: Boolean, default: true },
  theme: { accent: { type: String, default: '#16a34a' } },
  fulfillment: {
    deliveryEnabled: { type: Boolean, default: false },
    pickupEnabled: { type: Boolean, default: true },
    pickupInstructions: { type: String, default: '' },
    dineInEnabled: { type: Boolean, default: false },
    askTableNumber: { type: Boolean, default: false },
    // Radius delivery pricing: needs the restaurant's map location + the four numbers below.
    location: { placeId: String, googlePlaceId: String, address: String, lat: Number, lng: Number },
    radius: {
      baseFee: { type: Number, default: 0 }, baseDistanceKm: { type: Number, default: 0 },
      perKmRate: { type: Number, default: 0 }, maxRadiusKm: { type: Number, default: 0 },
      configured: { type: Boolean, default: false },
    },
  },
  payments: {
    paystackEnabled: { type: Boolean, default: false },
    bankTransferEnabled: { type: Boolean, default: false },
    podEnabled: { type: Boolean, default: false },
  },
  subscription: oid('Subscription'),
  plan: { type: String, enum: ['free', 'pro', 'business'], default: 'free', index: true }, // denormalised, maintained by subscription service
  // Order-for-later settings (owner-configurable). Hours come from the restaurant or branch; these control the booking window.
  scheduling: {
    enabled: { type: Boolean, default: false },
    maxDaysAhead: { type: Number, default: 7, min: 1, max: 60 },
    minNoticeMinutes: { type: Number, default: 60, min: 0, max: 7 * 24 * 60 },
    slotMinutes: { type: Number, default: 30, min: 10, max: 240 },
    capacityPerSlot: { type: Number, default: 0, min: 0, max: 500 }, // 0 = unlimited
    reminderMinutes: { type: Number, default: 60, min: 5, max: 180 }, // restaurant is reminded this long before the slot
    timezone: { type: String, default: 'Africa/Lagos' },
  },
  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  suspendReason: String,
}, { timestamps: true }));

export const Category = mongoose.model('Category', new Schema({
  restaurant: oid('Restaurant', { required: true, index: true }),
  name: { type: String, required: true, trim: true },
  sort: { type: Number, default: 0 },
}, { timestamps: true }));

export const Meal = mongoose.model('Meal', new Schema({
  restaurant: oid('Restaurant', { required: true, index: true }),
  category: oid('Category', { default: null }),
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, default: '', maxlength: 600 },
  price: { type: Number, required: true, min: 0 }, // naira
  image: String,
  available: { type: Boolean, default: true },
  prepTime: { type: Number, min: 0, max: 600, default: null }, // minutes
  portion: { type: String, trim: true, maxlength: 60, default: '' },
  // Optional size-based pricing (e.g. 10" Medium / 12" Large / 14" Family). When present, `price` mirrors the cheapest
  // available size so existing screens that show a single price keep working, and customers must pick a size.
  sizes: {
    type: [new Schema({
      name: { type: String, required: true, trim: true, maxlength: 60 },
      price: { type: Number, required: true, min: 0 },
      available: { type: Boolean, default: true },
    })],
    default: [],
  },
  tags: { type: [String], default: [] },
  popular: { type: Boolean, default: false },
  // Optional extras the restaurant recommends with this meal (extra turkey, drinks...). No images.
  addons: {
    type: [new Schema({
      name: { type: String, required: true, trim: true, maxlength: 80 },
      price: { type: Number, required: true, min: 0 },
      group: { type: String, trim: true, maxlength: 40, default: 'Extras' },
      available: { type: Boolean, default: true },
    })],
    default: [],
  },
}, { timestamps: true }));

const itemSnap = new Schema({
  meal: oid('Meal'), name: String,
  price: Number, // per-unit price INCLUDING size + add-ons, so line total is always price x quantity
  size: String, // chosen size label, when the meal is sold by size
  basePrice: Number, addons: [{ _id: false, name: String, price: Number }],
  quantity: Number,
}, { _id: false });

const orderSchema = new Schema({
  restaurant: oid('Restaurant', { required: true, index: true }),
  reference: { type: String, required: true, unique: true },
  channel: { type: String, enum: ['whatsapp', 'checkout'], required: true },
  // Where the order came from. Missing on older orders: treat as 'website' (or 'whatsapp' when channel is the old wa.me flow). See orderSourceFilter in services/whatsappOrders.js.
  source: { type: String, enum: ['website', 'whatsapp'] },
  trackingTokenHash: { type: String, index: true, sparse: true },
  trackingTokenEnc: { type: String, select: false }, // WhatsApp orders only: the token encrypted, so the tracking link can be re-sent. Lookups still use the hash.
  customerName: String, customerEmail: String, customerPhone: String,
  waCustomerId: { type: String, index: true, sparse: true }, // WhatsApp orders: the verified WhatsApp identity that placed it (ownership check for "track my order")
  items: [itemSnap],
  subtotal: Number, deliveryFee: { type: Number, default: 0 }, total: Number,
  fulfillment: { type: String, enum: ['whatsapp_pickup', 'delivery', 'pickup', 'dine_in'] },
  deliveryAddress: String, deliveryPlace: String, deliveryDistanceKm: Number, deliveryLocation: { lat: Number, lng: Number }, tableNumber: String,
  branch: oid('Branch', { default: null, index: true }), // null = the restaurant itself (single-location or pre-branch orders)
  branchName: String, // snapshot, so history survives a rename
  // Commission snapshot taken when the order is created (from the plan in force at that moment). Never from the client.
  commissionPct: { type: Number, default: 0 }, commissionAmount: { type: Number, default: 0 },
  refundedAmount: { type: Number, default: 0 },
  // Order for later. scheduledFor is the REAL fulfilment time (UTC instant) and is never changed by status updates.
  isScheduled: { type: Boolean, default: false }, scheduledFor: Date, slotReleased: { type: Boolean, default: false }, reminderSentAt: Date,
  paymentMethod: { type: String, enum: ['none', 'paystack', 'bank_transfer', 'pod'], default: 'none' },
  paymentStatus: { type: String, default: 'not_required' },
  status: { type: String, default: 'pending', index: true },
  notes: { type: String, maxlength: 500 },
  idempotencyKey: { type: String, index: true, sparse: true },
  audit: [{ at: Date, by: String, field: String, from: String, to: String, note: String }],
}, { timestamps: true });
// PERF (new): compound indexes that match how orders are really queried (always per restaurant, newest first, often by status).
// They replace in-memory sorting/filtering for the Orders page, today's counters and the dashboard statistics.
// Only 3 extra indexes on Order, so writes stay cheap. MongoDB builds them automatically on start-up (see the deployment note in the README).
orderSchema.index({ restaurant: 1, createdAt: -1 });          // orders list, "today" counters, analytics ranges
orderSchema.index({ restaurant: 1, status: 1, createdAt: -1 }); // filtered by status, new-order badge
orderSchema.index({ restaurant: 1, paymentStatus: 1 });        // "proofs to review" counter
orderSchema.index({ restaurant: 1, branch: 1, createdAt: -1 });   // branch dashboards
orderSchema.index({ restaurant: 1, source: 1, createdAt: -1 });  // WhatsApp / website filter
orderSchema.index({ isScheduled: 1, scheduledFor: 1 });          // reminders + upcoming list
export const Order = mongoose.model('Order', orderSchema);

// Food-order payments and subscription payments are separate collections on purpose.
export const OrderPayment = mongoose.model('OrderPayment', new Schema({
  restaurant: oid('Restaurant', { required: true, index: true }),
  order: oid('Order', { required: true, index: true }),
  provider: { type: String, default: 'paystack' },
  providerReference: { type: String, unique: true, sparse: true },
  amount: Number, currency: { type: String, default: 'NGN' },
  status: {
  type: String,
  enum: ['pending', 'success', 'failed', 'attention'],
  default: 'pending',
},

  verifiedAt: Date,
  raw: Schema.Types.Mixed,
}, { timestamps: true }));

export const Subscription = mongoose.model('Subscription', new Schema({
  restaurant: oid('Restaurant', { required: true, unique: true }),
  plan: { type: String, enum: ['free', 'pro', 'business'], default: 'free' },
  status: { type: String, enum: ['free', 'trialing', 'active', 'expired'], default: 'free' },
  trialUsed: { type: Boolean, default: false },
  trialStart: Date, trialEnd: Date,
  periodStart: Date, periodEnd: Date,
  lastPaymentReference: String,
  remindersSent: { d3: Boolean, d1: Boolean, expired: Boolean },
}, { timestamps: true }));

export const SubscriptionPayment = mongoose.model('SubscriptionPayment', new Schema({
  restaurant: oid('Restaurant', { required: true, index: true }),
  subscription: oid('Subscription'),
  provider: { type: String, default: 'paystack' },
  providerReference: { type: String, required: true, unique: true },
  amount: Number, currency: { type: String, default: 'NGN' },
  status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
  plan: { type: String, enum: ['pro', 'business'], default: 'pro' }, // which plan this payment bought
  interval: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' }, // what this payment bought
  periodDays: Number,   // length of access this payment grants (fixed when the payment is created)
  periodStart: Date, periodEnd: Date,
  verifiedAt: Date,
  raw: Schema.Types.Mixed, activationError: String, activationErrorAt: Date,
}, { timestamps: true }));

export const PaymentConfig = mongoose.model('PaymentConfig', new Schema({
  restaurant: oid('Restaurant', { required: true, unique: true }),
  provider: { type: String, default: 'paystack' },
  subaccountCode: String,
  onboardingStatus: { type: String, enum: ['not_configured', 'pending', 'active', 'attention'], default: 'not_configured' },
  settlementBankName: String,
  settlementAccountMasked: String,
  bank: { bankName: String, accountName: String, accountNumber: { type: String, select: false } },
}, { timestamps: true }));

export const PaymentProof = mongoose.model('PaymentProof', new Schema({
  order: oid('Order', { required: true, index: true }),
  restaurant: oid('Restaurant', { required: true, index: true }),
  fileRef: { type: String, required: true }, // private storage key, never a public URL
  status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  reviewer: oid('User'), reviewNotes: String, reviewedAt: Date,
}, { timestamps: true }));

export const DeliveryTier = mongoose.model('DeliveryTier', new Schema({
  restaurant: oid('Restaurant', { required: true, index: true }),
  position: { type: Number, default: 1 },
  name: { type: String, default: '' },
  fee: { type: Number, required: true, min: 0 },
  areas: { type: [String], default: [] }, // always stored lowercase so matching never depends on capitalisation
  active: { type: Boolean, default: true },
}, { timestamps: true }));

export const EmailLog = mongoose.model('EmailLog', new Schema({
  to: String, type: String, dedupeKey: { type: String, index: true, sparse: true },
  restaurant: oid('Restaurant'), order: oid('Order'),
  providerId: String,
  status: { type: String, enum: ['queued', 'accepted', 'failed'], default: 'queued' },
  attempts: { type: Number, default: 0 }, lastError: String,
  payload: Schema.Types.Mixed,
}, { timestamps: true }));

export const PlatformSetting = mongoose.model('PlatformSetting', new Schema({
  key: { type: String, unique: true }, value: Schema.Types.Mixed,
}, { timestamps: true }));

export const AuditLog = mongoose.model('AuditLog', new Schema({
  actor: oid('User'), action: String, target: String, detail: Schema.Types.Mixed,
}, { timestamps: true }));

/* ---------- WhatsApp Commerce: connection + the three independent on/off controls (rules in services/whatsappControls.js) ---------- */
const changeStamp = { _id: false, at: Date, by: oid('User'), byName: String };
export const WhatsAppIntegration = mongoose.model('WhatsAppIntegration', new Schema({
  restaurant: oid('Restaurant', { required: true, unique: true }), // one connection per restaurant; reconnecting reuses this row, so history stays attached
  wabaId: String,
  phoneNumberId: { type: String, index: { unique: true, sparse: true } }, // how an incoming webhook finds its restaurant
  displayPhoneNumber: String, verifiedDisplayName: String,
  encryptedAccessToken: { type: String, select: false }, // AES-256-GCM (services/tokenVault.js). Never returned by any API.
  tokenExpiresAt: Date,
  connectionStatus: { type: String, enum: ['not_connected', 'connecting', 'connected', 'verification_pending', 'action_required', 'disconnected', 'restricted', 'connection_expired'], default: 'not_connected' },
  coexistenceEnabled: { type: Boolean, default: false },
  encryptedRegistrationPin: { type: String, select: false }, // two-step PIN set when a NEW number is registered (not needed for coexistence numbers)
  lastWebhookReceivedAt: Date,
  suspended: { _id: false, at: Date, by: oid('User'), reason: String }, // set by the Ordarly administrator; blocks every send and every new order
  lastError: { _id: false, at: Date, code: String, message: String },
  // Last known Meta account information. Only what Meta actually returned: nothing here is ever estimated.
  meta: { _id: false, fetchedAt: Date, error: String, phone: Schema.Types.Mixed, waba: Schema.Types.Mixed, pricing: Schema.Types.Mixed },
  templates: Schema.Types.Mixed, // { order_update: { name, status } }: message templates created on THIS restaurant's WhatsApp account
  // Automation settings the restaurant controls. Anything that already exists in Ordarly (hours, delivery prices, address) is read from there, not copied here.
  settings: {
    _id: false,
    welcomeMessage: { type: String, maxlength: 600 }, businessDescription: { type: String, maxlength: 600 },
    outOfHoursMessage: { type: String, maxlength: 600 }, handoverMessage: { type: String, maxlength: 600 },
    categoryIds: [{ type: Schema.Types.ObjectId }],            // empty = every category
    allowDelivery: { type: Boolean, default: true }, allowPickup: { type: Boolean, default: true },
    allowOnlinePayment: { type: Boolean, default: true }, allowPayOnDelivery: { type: Boolean, default: true },
    confirmBeforeOrder: { type: Boolean, default: true },
    handoverEnabled: { type: Boolean, default: true },
    aiEnabled: { type: Boolean, default: false }, // the restaurant's own AI-assistance switch (off until the owner turns it on)
    notifyStatuses: { type: [String], default: ['paid', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled'] },
    staffNotify: { push: { type: Boolean, default: true }, email: { type: Boolean, default: true } },
    abandonHours: { type: Number, default: 24, min: 1, max: 168 },
  },
  // The two switches below default to OFF: nothing is sent or accepted until the restaurant turns it on.
  automationEnabled: { type: Boolean, default: false },
  acceptOrdersEnabled: { type: Boolean, default: false },
  // Changes every time automation is switched on or off. Queued automated messages remember it, so ones queued before a switch-off are never sent later.
  automationEpoch: { type: Number, default: 0 },
  automationEnabledAt: Date, // customer messages older than this are never answered automatically
  changes: { connection: changeStamp, automation: changeStamp, orders: changeStamp }, // who last changed each control, and when
}, { timestamps: true }));

export const WhatsAppControlLog = mongoose.model('WhatsAppControlLog', new Schema({
  restaurant: oid('Restaurant', { required: true, index: true }),
  control: { type: String, enum: ['connection', 'automation', 'orders'] },
  from: String, to: String, by: oid('User'), byName: String,
  note: String,
}, { timestamps: true }));

/* ---------- WhatsApp Commerce: conversations, messages, Ordarly message credits ---------- */
export const WhatsAppConversation = mongoose.model('WhatsAppConversation', (() => {
  const s = new Schema({
    restaurant: oid('Restaurant', { required: true }),
    customerWaId: { type: String, required: true }, // the customer's WhatsApp number, or 'bsuid:<id>' when Meta only gives a username-based id
    customerPhone: String, customerName: String,
    status: { type: String, enum: ['bot_active', 'human_pending', 'human_active', 'resolved'], default: 'bot_active' },
    conversationState: { type: String, default: 'greeting' }, // the ordering step (see services/whatsappEngine.js)
    flow: Schema.Types.Mixed, // small scratchpad for the current step (selected item, pending address choices, ...)
    currentCart: [{ _id: false, mealId: String, sizeId: String, addonIds: [String], quantity: Number }],
    cartVersion: { type: Number, default: 0 }, // changes with every cart edit; part of the "one order per cart" lock
    orderLock: Number, // cartVersion an order was already started for (stops double orders from repeated taps or retries)
    fulfillment: { type: String, enum: ['delivery', 'pickup'] },
    delivery: { _id: false, placeId: String, address: String, details: String, distanceKm: Number, fee: Number, baseFee: Number },
    branchId: String,
    currentOrderId: oid('Order'),
    confirmedName: String, contactPhone: String, phoneConfirmed: Boolean, // customer details collected in the chat (never taken from the WhatsApp profile name)
    savedOffered: Boolean, aiStrikes: Number, lastAiAt: Date,
    activeCheckoutSessionId: oid('CheckoutSession'),
    humanTakeover: { type: Boolean, default: false },
    assignedStaffId: oid('User'), assignedStaffName: String,
    handoverReason: String, handoverAt: Date, handoverAckAt: Date,
    greeted: { type: Boolean, default: false },
    failedAttempts: { type: Number, default: 0 },
    unreadCount: { type: Number, default: 0 },
    lastMessagePreview: String, lastMessageDirection: String,
    lastCustomerMessageAt: Date, lastOutboundMessageAt: Date, lastActivityAt: Date,
    creditNoticeCycle: String, // wallet cycle in which the one "automated replies are paused" notice was sent
    staffNotifiedAt: Date,
  }, { timestamps: true });
  s.index({ restaurant: 1, customerWaId: 1 }, { unique: true });          // one conversation per restaurant and customer
  s.index({ restaurant: 1, status: 1, lastActivityAt: -1 });
  s.index({ restaurant: 1, lastActivityAt: -1 });
  return s;
})());

export const WhatsAppMessage = mongoose.model('WhatsAppMessage', (() => {
  const s = new Schema({
    restaurant: oid('Restaurant', { required: true }),
    conversation: oid('WhatsAppConversation', { required: true }),
    customerWaId: String,
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    messageType: String, // text | interactive | image | location | template | unsupported | ...
    content: String,      // readable text shown in the inbox
    payload: Schema.Types.Mixed, // outbound: what is sent to Meta. inbound: nothing sensitive (no raw webhook body)
    metaMessageId: String,
    origin: { type: String, enum: ['customer', 'bot', 'staff', 'business_app'] }, // business_app = typed on the restaurant's own WhatsApp Business App
    sentByUser: oid('User'), sentByName: String,
    automated: { type: Boolean, default: false },
    // outbound queue
    sendStatus: { type: String, enum: ['queued', 'sending', 'sent', 'failed', 'cancelled'] },
    deliveryStatus: { type: String, enum: ['pending', 'sent', 'delivered', 'read', 'failed', 'unconfirmed'] },
    attempts: { type: Number, default: 0 }, nextAttemptAt: Date, lockedAt: Date,
    dedupeKey: String, // an outbound message with the same key is only ever queued once (e.g. "order status accepted for order X")
    epoch: Number, inboundAt: Date, // see services/whatsappControls.js guardAutomatedSend
    templateFallback: Schema.Types.Mixed, // used when the 24-hour customer window has closed
    allowDuringHuman: { type: Boolean, default: false }, // the one handover acknowledgement may go out after the conversation is flagged
    creditExempt: { type: Boolean, default: false }, exemptReason: String,
    order: oid('Order', { index: true, sparse: true }), orderEvent: String, // set on order notifications (confirmation, status updates) so the dashboard can show them
    messageCategory: { type: String, enum: ['service', 'utility', 'template'], default: 'service' },
    failureCode: String, failureReason: String, failureKind: String,
    creditReservationId: oid('WhatsAppMessageCreditReservation'),
    creditCharged: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now },
  }, { timestamps: true });
  s.index({ metaMessageId: 1 }, { unique: true, sparse: true }); // Meta message ids are unique: this is also what makes inbound webhooks idempotent
  s.index({ restaurant: 1, dedupeKey: 1 }, { unique: true, sparse: true });
  s.index({ conversation: 1, timestamp: 1 });
  s.index({ sendStatus: 1, nextAttemptAt: 1 });
  s.index({ restaurant: 1, direction: 1, createdAt: -1 });
  return s;
})());

// One row per Meta webhook item. The unique key makes a repeated (retried) delivery a no-op. Rows expire after 30 days.
// ---- AI assistance (Groq). Completely separate from Ordarly message credits and from Meta billing. ----
const aiEventSchema = new Schema({
  restaurant: oid('Restaurant', { index: true }), conversation: oid('WhatsAppConversation'), provider: String, model: String,
  status: { type: String, enum: ['ok', 'rate_limited', 'quota', 'timeout', 'network', 'auth', 'model', 'malformed', 'error', 'rejected'] },
  inputTokens: { type: Number, default: 0 }, outputTokens: { type: Number, default: 0 }, latencyMs: Number, intent: String, fallback: Boolean,
  createdAt: { type: Date, default: Date.now, index: { expires: 60 * 86400 } },
}, { versionKey: false });
export const AiUsageEvent = mongoose.model('AiUsageEvent', aiEventSchema);
const aiDailySchema = new Schema({
  day: { type: String, index: true }, restaurant: { type: Schema.Types.ObjectId, ref: 'Restaurant', default: null },
  requests: { type: Number, default: 0 }, ok: { type: Number, default: 0 }, failed: { type: Number, default: 0 }, rateLimited: { type: Number, default: 0 },
  fallbacks: { type: Number, default: 0 }, inputTokens: { type: Number, default: 0 }, outputTokens: { type: Number, default: 0 }, latencyMs: { type: Number, default: 0 },
}, { versionKey: false });
aiDailySchema.index({ day: 1, restaurant: 1 }, { unique: true }); // restaurant:null row = the global total for that day
export const AiUsageDaily = mongoose.model('AiUsageDaily', aiDailySchema);
export const AiProviderState = mongoose.model('AiProviderState', new Schema({
  key: { type: String, unique: true }, state: { type: String, enum: ['closed', 'open'], default: 'closed' }, openUntil: Date, permanent: Boolean,
  reason: String, consecutiveFailures: { type: Number, default: 0 }, lastSuccessAt: Date, lastError: { _id: false, at: Date, kind: String, message: String },
}, { timestamps: true }));

export const WhatsAppWebhookEvent = mongoose.model('WhatsAppWebhookEvent', (() => {
  const s = new Schema({
    key: { type: String, required: true, unique: true },
    restaurant: oid('Restaurant'), phoneNumberId: String, wabaId: String, field: String,
    payload: Schema.Types.Mixed,
    processed: { type: Boolean, default: false }, attempts: { type: Number, default: 0 }, lastError: String, nextAttemptAt: Date,
  }, { timestamps: true });
  s.index({ processed: 1, nextAttemptAt: 1 });
  s.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 });
  return s;
})());

// Ordarly's own message credits. NOT Meta billing: these two systems are never combined.
export const OrdarlyCreditWallet = mongoose.model('OrdarlyCreditWallet', new Schema({
  restaurant: oid('Restaurant', { required: true, unique: true }),
  plan: String, cycleId: String,
  monthlyAllowance: { type: Number, default: 0 }, monthlyUsed: { type: Number, default: 0 },
  grantedThisCycle: { type: Number, default: 0 }, // highest allowance given in this cycle: switching plans back and forth can never earn more than the best plan's allowance
  purchasedBalance: { type: Number, default: 0 },
  purchasedGranted: { type: Number, default: 0 }, purchasedConsumed: { type: Number, default: 0 }, // running totals, used to work out which purchased pack is used first
  reservedMonthly: { type: Number, default: 0 }, reservedPurchased: { type: Number, default: 0 },
  billingCycleStart: Date, billingCycleEnd: Date, lastRenewedAt: Date,
  warned: { _id: false, p25: String, p10: String, zero: String }, // cycle id each warning was last sent for (so it is sent once)
}, { timestamps: true }));

export const OrdarlyCreditTransaction = mongoose.model('OrdarlyCreditTransaction', (() => {
  const s = new Schema({
    restaurant: oid('Restaurant', { required: true }),
    transactionType: { type: String, enum: ['monthly_allocation', 'message_reservation', 'message_deduction', 'message_refund', 'topup_purchase', 'admin_adjustment', 'credit_expiry'], required: true },
    amount: Number, // credits: positive adds, negative removes
    pool: { type: String, enum: ['monthly', 'purchased'] },
    source: String, reference: String, messageId: oid('WhatsAppMessage'), paymentReference: String, description: String,
    previousBalance: Number, newBalance: Number, // total available credits before and after
    status: { type: String, default: 'completed' },
    expiresAt: Date, expiryProcessed: { type: Boolean, default: false }, // purchased packs only
    adminId: oid('User'), adminName: String, reason: String,
  }, { timestamps: true });
  s.index({ reference: 1 }, { unique: true, sparse: true }); // makes monthly allocations, purchases and deductions idempotent
  s.index({ restaurant: 1, createdAt: -1 });
  return s;
})());

export const WhatsAppMessageCreditReservation = mongoose.model('WhatsAppMessageCreditReservation', (() => {
  const s = new Schema({
    restaurant: oid('Restaurant', { required: true }),
    messageId: oid('WhatsAppMessage', { required: true }),
    reservedAmount: { type: Number, default: 1 },
    pool: { type: String, enum: ['monthly', 'purchased'] },
    finalStatus: { type: String, enum: ['reserved', 'settled', 'released'], default: 'reserved' },
    releaseReason: String, transactionId: oid('OrdarlyCreditTransaction'),
    reservedAt: { type: Date, default: Date.now }, settledAt: Date,
  }, { timestamps: true });
  s.index({ messageId: 1 }, { unique: true }); // one reservation per message: a message can never be charged twice
  s.index({ finalStatus: 1, reservedAt: 1 });
  return s;
})());

export const WhatsAppCreditPackage = mongoose.model('WhatsAppCreditPackage', new Schema({
  name: { type: String, required: true }, credits: { type: Number, required: true, min: 1 },
  price: { type: Number, default: 0, min: 0 }, // set by the Ordarly administrator: never defaulted to a made-up price
  active: { type: Boolean, default: false },
  expiryDays: { type: Number, default: null }, // null = purchased credits never expire. Shown to the restaurant before it buys.
  sort: { type: Number, default: 0 },
}, { timestamps: true }));

export const WhatsAppCreditPurchase = mongoose.model('WhatsAppCreditPurchase', new Schema({
  restaurant: oid('Restaurant', { required: true, index: true }),
  package: oid('WhatsAppCreditPackage'), packageName: String, credits: Number, amount: Number, expiryDays: Number, // snapshot at purchase time
  providerReference: { type: String, required: true, unique: true },
  status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
  verifiedAt: Date, raw: Schema.Types.Mixed,
}, { timestamps: true }));

// "Continue on WhatsApp": a website cart handed to WhatsApp. Only the HASH of the token is stored; rows expire on their own.
export const CheckoutSession = mongoose.model('CheckoutSession', (() => {
  const s = new Schema({
    restaurant: oid('Restaurant', { required: true }),
    sessionTokenHash: { type: String, required: true, unique: true },
    customerWaId: String,
    items: [{ _id: false, mealId: String, sizeId: String, addonIds: [String], quantity: Number }],
    branchId: String, deliveryMethod: String,
    expiry: { type: Date, required: true },
    status: { type: String, enum: ['pending', 'claimed', 'expired'], default: 'pending' },
  }, { timestamps: true });
  s.index({ expiry: 1 }, { expireAfterSeconds: 3600 }); // removed an hour after it expires
  return s;
})());

export const WebhookEvent = mongoose.model('WebhookEvent', new Schema({
  provider: String, eventId: { type: String, unique: true }, type: String,
}, { timestamps: true }));

export const ErrorLog = mongoose.model('ErrorLog', new Schema({
  route: String, method: String, message: String, stack: String, status: Number,
}, { timestamps: true }));

const complaintSchema = new Schema({
  reference: { type: String, unique: true },
  kind: { type: String, enum: ['complaint', 'question', 'feedback'], default: 'question' },
  source: { type: String, enum: ['contact', 'restaurant_page', 'tracking', 'restaurant'], default: 'contact' },
  name: String, email: { type: String, index: true }, phone: String, subject: String, message: String,
  restaurant: oid('Restaurant'), orderRef: String,
  status: { type: String, enum: ['open', 'reviewed', 'in_review', 'resolved', 'dismissed'], default: 'open', index: true },
  priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
  notes: [{ _id: false, by: String, at: Date, text: String }],
  replies: [{ _id: false, by: String, at: Date, message: String }],
}, { timestamps: true });
// PERF (new): the dashboard's "open reports" counter (restaurant + source + status) and the admin inbox (status filter, newest first).
complaintSchema.index({ restaurant: 1, source: 1, status: 1 });
complaintSchema.index({ status: 1, createdAt: -1 });
export const Complaint = mongoose.model('Complaint', complaintSchema);

// Messages customers send to a restaurant from its public page. Visible only to that restaurant.
const restaurantMessageSchema = new Schema({
  restaurant: oid('Restaurant', { required: true, index: true }),
  reference: { type: String, unique: true },
  name: String, email: String, phone: String, subject: String, message: String, orderRef: String,
  status: { type: String, enum: ['new', 'read', 'replied', 'closed'], default: 'new', index: true },
  replies: [{ _id: false, by: String, at: Date, message: String }],
}, { timestamps: true });
// PERF (new): the Messages tab and the unread badge filter by restaurant + status and sort newest first.
restaurantMessageSchema.index({ restaurant: 1, status: 1, createdAt: -1 });
export const RestaurantMessage = mongoose.model('RestaurantMessage', restaurantMessageSchema);

// Browser push subscriptions (one per device/browser) so restaurant owners get device notifications.
export const PushSubscription = mongoose.model('PushSubscription', new Schema({
  user: oid('User', { required: true, index: true }),
  restaurant: oid('Restaurant', { required: true, index: true }),
  endpoint: { type: String, required: true, unique: true },
  keys: { p256dh: String, auth: String },
  userAgent: String,
}, { timestamps: true }));

/* ================= Business plan: branches, staff ================= */
export const Branch = mongoose.model('Branch', new Schema({
  restaurant: oid('Restaurant', { required: true, index: true }),
  name: { type: String, required: true, trim: true, maxlength: 80 },
  address: { type: String, trim: true, maxlength: 300, default: '' },
  location: { placeId: String, googlePlaceId: String, address: String, lat: Number, lng: Number },
  phone: { type: String, trim: true },
  whatsapp: String,
  openingHours: { type: [{ _id: false, day: Number, open: String, close: String, closed: Boolean }], default: [] }, // empty = use the restaurant's hours
  acceptingOrders: { type: Boolean, default: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
  prepTimeMinutes: { type: Number, min: 0, max: 600, default: null },
  fulfillment: {
    pickupEnabled: { type: Boolean, default: true },
    dineInEnabled: { type: Boolean, default: false },
    deliveryEnabled: { type: Boolean, default: false },
    pickupInstructions: { type: String, default: '' },
    radius: { baseFee: { type: Number, default: 0 }, baseDistanceKm: { type: Number, default: 0 }, perKmRate: { type: Number, default: 0 }, maxRadiusKm: { type: Number, default: 0 }, configured: { type: Boolean, default: false } },
  },
  sort: { type: Number, default: 0 },
}, { timestamps: true }));

// A branch shares the restaurant's menu. These rows are the per-branch differences: sold out here, or a different price here.
export const BranchMealOverride = mongoose.model('BranchMealOverride', (() => {
  const sch = new Schema({
    restaurant: oid('Restaurant', { required: true, index: true }),
    branch: oid('Branch', { required: true }),
    meal: oid('Meal', { required: true }),
    available: { type: Boolean, default: null },   // null = inherit
    price: { type: Number, min: 0, default: null }, // null = inherit (for meals sold without sizes)
    sizes: { type: [new Schema({ sizeId: String, price: { type: Number, min: 0, default: null }, available: { type: Boolean, default: null } }, { _id: false })], default: [] },
  }, { timestamps: true });
  sch.index({ branch: 1, meal: 1 }, { unique: true });
  return sch;
})());

export const StaffMember = mongoose.model('StaffMember', (() => {
  const sch = new Schema({
    restaurant: oid('Restaurant', { required: true, index: true }),
    email: { type: String, required: true, lowercase: true, trim: true },
    name: String,
    user: oid('User', { default: null, index: true }),
    role: { type: String, enum: ['branch_manager', 'all_branches_manager', 'custom'], required: true },
    branches: [oid('Branch')],
    allBranches: { type: Boolean, default: false }, // custom role only
    perms: { type: [String], default: [] },         // custom role only
    status: { type: String, enum: ['invited', 'active', 'revoked'], default: 'invited' },
    tokenHash: { type: String, index: true, sparse: true },
    expiresAt: Date,
    invitedBy: oid('User'),
    acceptedAt: Date,
  }, { timestamps: true });
  sch.index({ restaurant: 1, email: 1 }, { unique: true });
  return sch;
})());

/* ================= Money ledger (one entry per order, created once) ================= */
export const LedgerEntry = mongoose.model('LedgerEntry', (() => {
  const sch = new Schema({
    restaurant: oid('Restaurant', { required: true }),
    branch: oid('Branch', { default: null }),
    order: oid('Order', { required: true }),
    orderRef: String,
    // held = paid, order not finished yet (pending settlement). earned = order completed, commission recognised.
    // reversed = order cancelled or fully refunded: no commission, nothing earned.
    status: { type: String, enum: ['held', 'earned', 'reversed'], default: 'held' },
    plan: String,
    paymentMethod: String,
    mealSubtotal: { type: Number, default: 0 },
    deliveryFee: { type: Number, default: 0 },
    commissionPct: { type: Number, default: 0 },
    commission: { type: Number, default: 0 },          // commission Ordarly keeps after refunds
    commissionCharged: { type: Number, default: 0 },   // what the payment split actually sent to Ordarly at payment time
    commissionReturnDue: { type: Number, default: 0 }, // part of the charged commission that must go back to the restaurant
    commissionReturnedAt: Date,
    gatewayFee: { type: Number, default: null },       // Paystack fee when Paystack reported it
    refunded: { type: Number, default: 0 },
    net: { type: Number, default: 0 },                 // restaurant net = meals - commission + delivery (x refund share), before gateway fees
    eventAt: { type: Date, default: Date.now },        // paid time, then completion time: the date used by report filters
    completedAt: Date, reversedAt: Date,
    legacy: { type: Boolean, default: false },         // created for orders that existed before commissions (commission 0)
  }, { timestamps: true });
  sch.index({ order: 1 }, { unique: true });          // the database guarantees one ledger entry per order, so commission can never be booked twice
  sch.index({ restaurant: 1, status: 1, eventAt: -1 });
  sch.index({ restaurant: 1, branch: 1, eventAt: -1 });
  sch.index({ commissionReturnDue: 1, commissionReturnedAt: 1 });
  return sch;
})());

// Slot capacity for scheduled orders. count is only changed with atomic conditional updates.
export const SlotBooking = mongoose.model('SlotBooking', (() => {
  const sch = new Schema({ restaurant: oid('Restaurant', { required: true }), branch: oid('Branch', { default: null }), slotStart: { type: Date, required: true }, count: { type: Number, default: 0 } });
  sch.index({ restaurant: 1, branch: 1, slotStart: 1 }, { unique: true });
  return sch;
})());
