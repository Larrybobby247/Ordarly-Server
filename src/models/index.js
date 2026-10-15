import mongoose from 'mongoose';
const { Schema } = mongoose;
const oid = (ref, extra = {}) => ({ type: Schema.Types.ObjectId, ref, ...extra });

export const User = mongoose.model('User', new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['owner', 'admin'], default: 'owner' },
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
  customDomainStatus: { type: String, enum: ['none', 'pending_dns', 'verified'], default: 'none' },
  customDomainToken: { type: String },
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
    location: { placeId: String, address: String, lat: Number, lng: Number },
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
  plan: { type: String, enum: ['free', 'pro'], default: 'free', index: true }, // denormalised, maintained by subscription service
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
  price: Number, // per-unit price INCLUDING add-ons, so line total is always price x quantity
  basePrice: Number, addons: [{ _id: false, name: String, price: Number }],
  quantity: Number,
}, { _id: false });

const orderSchema = new Schema({
  restaurant: oid('Restaurant', { required: true, index: true }),
  reference: { type: String, required: true, unique: true },
  channel: { type: String, enum: ['whatsapp', 'checkout'], required: true },
  trackingTokenHash: { type: String, index: true, sparse: true },
  customerName: String, customerEmail: String, customerPhone: String,
  items: [itemSnap],
  subtotal: Number, deliveryFee: { type: Number, default: 0 }, total: Number,
  fulfillment: { type: String, enum: ['whatsapp_pickup', 'delivery', 'pickup', 'dine_in'] },
  deliveryAddress: String, deliveryPlace: String, deliveryDistanceKm: Number, deliveryLocation: { lat: Number, lng: Number }, tableNumber: String,
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
export const Order = mongoose.model('Order', orderSchema);

// Food-order payments and subscription payments are separate collections on purpose.
export const OrderPayment = mongoose.model('OrderPayment', new Schema({
  restaurant: oid('Restaurant', { required: true, index: true }),
  order: oid('Order', { required: true, index: true }),
  provider: { type: String, default: 'paystack' },
  providerReference: { type: String, unique: true, sparse: true },
  amount: Number, currency: { type: String, default: 'NGN' },
  status: { type: String, default: 'pending' },
  verifiedAt: Date,
  raw: Schema.Types.Mixed,
}, { timestamps: true }));

export const Subscription = mongoose.model('Subscription', new Schema({
  restaurant: oid('Restaurant', { required: true, unique: true }),
  plan: { type: String, enum: ['free', 'pro'], default: 'free' },
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
  periodStart: Date, periodEnd: Date,
  verifiedAt: Date,
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
