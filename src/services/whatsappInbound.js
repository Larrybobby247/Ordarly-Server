// Processes ONE stored Meta webhook event: finds the restaurant, saves the message, and (when allowed) lets the conversation engine answer.
// Everything here is idempotent: a repeated event finds its message already saved (unique Meta message id) and does nothing more.
import { WhatsAppIntegration, WhatsAppConversation, WhatsAppMessage, Category, Meal, Order, CheckoutSession, Restaurant } from '../models/index.js';
import * as P from './whatsappPayloads.js';
import { handleInbound } from './whatsappEngine.js';
import { modeForInbound, currentEpoch, canCreateOrder } from './whatsappControlsStore.js';
import { enqueue, processMessage, applyStatus } from './whatsappSender.js';
import { syncWallet } from './whatsappCredits.js';
import { availability } from './whatsappCreditsMath.js';
import { loadContext, methodsFor, fulfilmentFor, createWhatsAppOrder } from './whatsappOrders.js';
import { notifyStaffHandover } from './whatsappNotify.js';
import { autocomplete, signedPlaceFromCoords } from './places.js';
import { quoteDelivery } from './delivery.js';
import { priceCart } from '../routes/public.js';
import { applyOverride, overrideMap } from './branches.js';
import { sha256 } from '../utils/helpers.js';
import { cleanPhone, displayPhone } from './whatsappCustomer.js';
import { trackStatusText, ACTIVE_STATUSES } from './whatsappMessages.js';
import { trackingLinkFor } from './whatsappOrders.js';
import { interpretWithAi, aiClient } from './whatsappAi.js';
import { getAiLimits } from './aiStore.js';

const isDup = (e) => e?.code === 11000;
const DEFAULT_ACK = 'Thanks! A member of our team will reply here shortly.';

async function upsertConversation(restaurant, id) {
  const q = { restaurant, customerWaId: id.key };
  try { return await WhatsAppConversation.findOneAndUpdate(q, { $setOnInsert: { ...q, customerPhone: id.phone || undefined, customerName: id.name || undefined, lastActivityAt: new Date() } }, { upsert: true, new: true }); }
  catch (e) { if (isDup(e)) return WhatsAppConversation.findOne(q); throw e; }
}

/** Everything the engine may ask for. Read fresh for every customer message, so a dashboard change applies immediately. */
async function buildDeps(conv, integ, limits = {}) {
  const settings = integ.settings || {};
  let ctx = null;
  const getCtx = async () => (ctx ||= await loadContext(conv.restaurant, conv.branchId));
  const mapMeal = (m, ov) => { const x = applyOverride(m, ov); return { id: String(x._id), name: x.name, price: x.price, description: x.description, available: x.available !== false,
    sizes: (x.sizes || []).filter((s) => s.available !== false).map((s) => ({ id: String(s._id), name: s.name, price: s.price })),
    addons: (x.addons || []).filter((a) => a.available !== false).map((a) => ({ id: String(a._id), name: a.name, price: a.price })) }; };
  const allowedCat = (id) => !settings.categoryIds?.length || settings.categoryIds.some((c) => String(c) === String(id));
  return {
    restaurant: async () => {
      const c = await getCtx();
      if (!c) return { name: 'This restaurant', isOpen: false, menuUrl: process.env.CLIENT_URL, settings };
      const needsBranch = !!(c.ctx.required || c.ctx.error);
      return { name: c.rest.name, isOpen: c.isOpen && !needsBranch, menuUrl: `${process.env.CLIENT_URL}/r/${c.rest.slug}`,
        settings: needsBranch ? { ...settings, outOfHoursMessage: 'This restaurant has several branches. Please order on our website so you can choose one:' } : settings };
    },
    categories: async () => {
      const c = await getCtx(); const ovs = await overrideMap(c.branchId);
      const [cats, meals] = await Promise.all([Category.find({ restaurant: c.rest._id }).sort('sort name').lean(), Meal.find({ restaurant: c.rest._id }).select('category available').lean()]);
      return cats.filter((k) => allowedCat(k._id)).map((k) => ({ id: String(k._id), name: k.name, count: meals.filter((m) => String(m.category) === String(k._id) && applyOverride(m, ovs.get(String(m._id))).available !== false).length })).filter((k) => k.count);
    },
    items: async (catId) => {
      const c = await getCtx(); if (!allowedCat(catId) || !/^[a-f0-9]{24}$/.test(catId)) return [];
      const ovs = await overrideMap(c.branchId);
      return (await Meal.find({ restaurant: c.rest._id, category: catId }).sort('name').lean()).map((m) => mapMeal(m, ovs.get(String(m._id)))).filter((m) => m.available);
    },
    meal: async (id) => {
      const c = await getCtx(); if (!/^[a-f0-9]{24}$/.test(id || '')) return null;
      const m = await Meal.findOne({ _id: id, restaurant: c.rest._id }).lean(); if (!m) return null;
      const ovs = await overrideMap(c.branchId); const x = mapMeal(m, ovs.get(String(m._id)));
      return x.available ? x : null;
    },
    price: async (cart) => { const c = await getCtx(); const p = await priceCart(c.rest, cart.map((l) => ({ mealId: l.mealId, sizeId: l.sizeId || undefined, addonIds: [...(l.addonIds || [])], quantity: l.quantity })), c.branchId); return { items: p.items, unavailable: p.unavailable, subtotal: p.subtotal }; },
    canOrder: async () => (await canCreateOrder(conv.restaurant)).ok,
    fulfilmentOptions: async () => fulfilmentFor(await getCtx(), settings),
    paymentMethods: async (f) => methodsFor(await getCtx(), settings, f),
    placeFromCoords: async (loc) => signedPlaceFromCoords({ lat: loc.lat, lng: loc.lng, address: loc.address || loc.name }),
    searchAddress: async (q) => { const c = await getCtx(); const f = c.er.fulfillment; return autocomplete(q, { bias: f?.location?.lat != null ? { lat: f.location.lat, lng: f.location.lng, radiusM: 20000 } : undefined }); },
    quote: async (placeId) => {
      const c = await getCtx(); const q = await quoteDelivery(c.er, placeId);
      return q.ok ? { ok: true, placeId: q.place.placeId, address: q.place.address, distanceKm: q.distanceKm, fee: q.fee } : { ok: false, maxRadiusKm: q.rules.maxRadiusKm };
    },
    cleanPhone,
    threshold: limits.confidenceThreshold,
    menuIndex: async () => {
      const c = await getCtx(); const ovs = await overrideMap(c.branchId);
      const cats = (await Category.find({ restaurant: c.rest._id }).select('_id').lean()).filter((k) => allowedCat(k._id)).map((k) => k._id);
      return (await Meal.find({ restaurant: c.rest._id, category: { $in: cats } }).sort('name').lean()).map((m) => mapMeal(m, ovs.get(String(m._id)))).filter((m) => m.available);
    },
    // Saved details come only from THIS restaurant's earlier WhatsApp orders placed by this same verified WhatsApp identity.
    savedDetails: async () => {
      const o = await Order.findOne({ restaurant: conv.restaurant, source: 'whatsapp', waCustomerId: conv.customerWaId, customerName: { $ne: 'WhatsApp customer' } }).sort('-createdAt').lean();
      if (!o) return null;
      const d = { name: o.customerName };
      if (o.fulfillment === 'delivery' && o.deliveryLocation?.lat != null) {
        try { d.placeId = signedPlaceFromCoords({ lat: o.deliveryLocation.lat, lng: o.deliveryLocation.lng, address: o.deliveryPlace }); d.address = [o.deliveryAddress, o.deliveryPlace].filter(Boolean).join(', ') || o.deliveryPlace; } catch { /* no saved address */ }
      }
      return d;
    },
    lastOrderLines: async () => {
      const o = await Order.findOne({ restaurant: conv.restaurant, source: 'whatsapp', waCustomerId: conv.customerWaId, paymentStatus: { $in: ['paid', 'unpaid_pod'] } }).sort('-createdAt').lean();
      if (!o) return [];
      const meals = await Meal.find({ restaurant: conv.restaurant, _id: { $in: o.items.map((i) => i.meal).filter(Boolean) } }).lean();
      const out = [];
      for (const i of o.items) {
        const m = meals.find((x) => String(x._id) === String(i.meal)); if (!m) continue;
        const size = i.size ? (m.sizes || []).find((x) => x.name === i.size) : null; if (i.size && !size) continue;
        const addonIds = []; let bad = false;
        for (const a of i.addons || []) { const f = (m.addons || []).find((x) => x.name === a.name); f ? addonIds.push(String(f._id)) : (bad = true); }
        if (!bad) out.push({ mealId: String(m._id), sizeId: size ? String(size._id) : undefined, addonIds, quantity: i.quantity });
      }
      return out;
    },
    // "Track my order": only orders placed by this WhatsApp identity at THIS restaurant. A reference that is not theirs looks the same as one that does not exist.
    trackOrders: async (cv, reference) => {
      const mine = { restaurant: conv.restaurant, source: 'whatsapp', waCustomerId: conv.customerWaId };
      const shape = async (o) => ({ reference: o.reference, statusText: trackStatusText(o), link: await trackingLinkFor(o) });
      if (reference) { const o = await Order.findOne({ ...mine, reference: String(reference).toUpperCase() }).select('+trackingTokenEnc').lean(); return { orders: o ? [await shape(o)] : [] }; }
      const active = await Order.find({ ...mine, status: { $in: ACTIVE_STATUSES } }).sort('-createdAt').limit(8).select('+trackingTokenEnc').lean();
      if (active.length) return { orders: await Promise.all(active.map(shape)) };
      const last = await Order.findOne(mine).sort('-createdAt').select('+trackingTokenEnc').lean();
      return { orders: last ? [await shape(last)] : [] };
    },
    ai: limits.aiOn ? async ({ text, state, menu }) => interpretWithAi({ restaurantId: conv.restaurant, conversationId: conv._id, text, state, menu }) : undefined,
    createOrder: ({ conv: cv, method }) => createWhatsAppOrder({ conv: { ...cv, _id: conv._id, restaurant: conv.restaurant, customerWaId: conv.customerWaId, customerPhone: cv.customerPhone || conv.customerPhone }, method }),
    claimSession: async (token) => {
      const s = await CheckoutSession.findOneAndUpdate({ sessionTokenHash: sha256(token), restaurant: conv.restaurant, status: 'pending', expiry: { $gt: new Date() } }, { $set: { status: 'claimed', customerWaId: conv.customerWaId } });
      return s ? { items: s.items.map((i) => ({ mealId: i.mealId, sizeId: i.sizeId, addonIds: [...(i.addonIds || [])], quantity: i.quantity })), branchId: s.branchId } : null;
    },
  };
}

function applyPatch(patch) {
  const { __handover, ...p } = patch; const $set = {}, $unset = {};
  for (const [k, v] of Object.entries(p)) (v === undefined ? ($unset[k] = 1) : ($set[k] = v));
  return { ...(Object.keys($set).length && { $set }), ...(Object.keys($unset).length && { $unset }) };
}

async function startHandover(conv, rest, integ, reason, epoch, inboundAt, outs) {
  const first = !conv.handoverAckAt;
  await WhatsAppConversation.updateOne({ _id: conv._id }, { $set: { status: 'human_pending', humanTakeover: true, handoverReason: reason, handoverAt: new Date(), ...(first && { handoverAckAt: new Date() }) } });
  // Anything the bot already queued for this customer is no longer wanted: a person is taking over.
  await WhatsAppMessage.updateMany({ conversation: conv._id, automated: true, allowDuringHuman: false, sendStatus: 'queued' }, { $set: { sendStatus: 'cancelled', deliveryStatus: 'failed', failureKind: 'handover', failureReason: 'A team member is taking over this conversation.' } });
  if (first && integ.settings?.handoverEnabled !== false) {
    const m = await enqueue(conv, P.text(integ.settings?.handoverMessage || DEFAULT_ACK), { automated: true, epoch, inboundAt, allowDuringHuman: true, dedupeKey: `handover-ack:${conv._id}:${conv.handoverAt?.getTime?.() || Date.now()}`, noKick: true });
    outs.push(m);
  }
  await notifyStaffHandover(conv, rest, integ, reason);
}

async function onMessage(ev, integ) {
  const id = P.customerIdentity(ev.contact, ev.message); if (!id) return;
  const n = P.normalizeInbound(ev.message);
  const conv = await upsertConversation(integ.restaurant, id);
  try {
    await WhatsAppMessage.create({ restaurant: integ.restaurant, conversation: conv._id, customerWaId: conv.customerWaId, direction: 'inbound', messageType: n.type, content: P.previewOf(n), origin: 'customer', metaMessageId: n.id, timestamp: n.timestamp });
  } catch (e) { if (isDup(e)) return; throw e; } // already handled
  const upd = { lastCustomerMessageAt: n.timestamp, lastActivityAt: new Date(), lastMessagePreview: P.previewOf(n).slice(0, 140), lastMessageDirection: 'inbound', ...(id.name && !conv.customerName ? { customerName: id.name } : {}) };
  if (conv.status === 'resolved') Object.assign(upd, { status: 'bot_active', humanTakeover: false, conversationState: 'greeting', handoverAckAt: null });
  const fresh = await WhatsAppConversation.findOneAndUpdate({ _id: conv._id }, { $set: upd, $inc: { unreadCount: 1 } }, { new: true });
  const rest = await Restaurant.findById(integ.restaurant).select('name email slug').lean(); if (!rest) return;

  const mode = await modeForInbound(integ.restaurant, { messageAt: n.timestamp });
  const live = await WhatsAppIntegration.findById(integ._id).lean();
  if (mode === 'none') return;
  if (mode === 'manual' || ['human_pending', 'human_active'].includes(fresh.status)) { // a person answers: never reply automatically
    await notifyStaffHandover(fresh, rest, live, 'New customer message'); return;
  }

  const epoch = await currentEpoch(integ.restaurant);
  // Ordarly credits: when they are finished the bot stays quiet. The customer gets ONE notice per credit cycle (not charged), staff are told.
  const w = await syncWallet(integ.restaurant);
  if (availability(w).usable <= 0) {
    if (fresh.creditNoticeCycle !== w.cycleId) {
      await WhatsAppConversation.updateOne({ _id: conv._id }, { creditNoticeCycle: w.cycleId });
      const m = await enqueue(fresh, P.text('Thanks for your message. Automated replies are paused for now, and the restaurant will reply to you personally.'), { automated: true, epoch, inboundAt: n.timestamp, creditExempt: true, exemptReason: 'credits_exhausted_notice', dedupeKey: `credit-notice:${conv._id}:${w.cycleId}`, noKick: true });
      await processMessage(m._id);
    }
    await notifyStaffHandover(fresh, rest, live, 'Automated replies are paused because your Ordarly message credits are finished.');
    return;
  }

  // AI is an optional helper: only when this restaurant turned it on, the platform switch is on and the provider is available. Otherwise the deterministic reader answers alone.
  const limits = await getAiLimits().catch(() => ({}));
  let aiOn = false;
  try { aiOn = !!live.settings?.aiEnabled && !limits.disabled && !!aiClient.configured(); } catch { aiOn = false; }
  const deps = await buildDeps(fresh, live, { ...limits, aiOn });
  // A customer who comes back after a long silence starts from the greeting (their cart is kept) instead of in the middle of an old step.
  const forEngine = fresh.toObject();
  const idle = conv.lastCustomerMessageAt && Date.now() - new Date(conv.lastCustomerMessageAt) > (live.settings?.abandonHours || 24) * 3600000;
  if (idle && forEngine.conversationState !== 'greeting') Object.assign(forEngine, { conversationState: 'greeting', flow: {}, greeted: true });
  let res;
  try { res = await handleInbound({ conv: forEngine, msg: n, mode, deps }); }
  catch (e) { console.error('[whatsapp engine]', e); await startHandover(fresh, rest, live, 'Something went wrong while answering automatically.', epoch, n.timestamp, []); return; }

  const upd2 = applyPatch(res.patch);
  if (Object.keys(upd2).length) await WhatsAppConversation.updateOne({ _id: conv._id }, upd2);
  const queued = [];
  for (const [i, b] of res.out.entries())
    queued.push(await enqueue(fresh, b, { automated: true, epoch, inboundAt: n.timestamp, dedupeKey: `reply:${n.id}:${i}`, noKick: true, at: new Date(Date.now() + i) }));
  if (res.handover) await startHandover(fresh, rest, live, res.handover, epoch, n.timestamp, queued);
  for (const m of queued) await processMessage(m._id); // in order
}

async function onEcho(ev, integ) {
  const e = ev.echo; const to = String(e.to || '').replace(/\D/g, ''); if (!to) return;
  const conv = await upsertConversation(integ.restaurant, { key: to, phone: to });
  const body = e.type === 'text' ? e.text?.body : `[${e.type || 'message'}]`;
  try { await WhatsAppMessage.create({ restaurant: integ.restaurant, conversation: conv._id, customerWaId: conv.customerWaId, direction: 'outbound', messageType: e.type || 'text', content: String(body || '').slice(0, 1000), origin: 'business_app', metaMessageId: e.id, sendStatus: 'sent', deliveryStatus: 'sent', creditExempt: true, exemptReason: 'sent_in_whatsapp_business_app', timestamp: e.timestamp ? new Date(Number(e.timestamp) * 1000) : new Date() }); }
  catch (err) { if (isDup(err)) return; throw err; }
  // The owner typed a reply on their phone: that is a person taking over, so the bot stops and queued automated replies are dropped.
  await WhatsAppConversation.updateOne({ _id: conv._id }, { $set: { status: 'human_active', humanTakeover: true, lastActivityAt: new Date(), lastMessagePreview: String(body || '').slice(0, 140), lastMessageDirection: 'outbound' } });
  await WhatsAppMessage.updateMany({ conversation: conv._id, automated: true, sendStatus: 'queued' }, { $set: { sendStatus: 'cancelled', deliveryStatus: 'failed', failureKind: 'handover', failureReason: 'The restaurant replied from the WhatsApp Business app.' } });
}

const RESTRICT = new Set(['ACCOUNT_VIOLATION', 'DISABLED_UPDATE', 'ACCOUNT_RESTRICTION']);
const REMOVED = new Set(['PARTNER_REMOVED', 'PARTNER_APP_UNINSTALLED']);
async function onAccount(ev, integ) {
  const v = ev.value || {}; const event = String(v.event || v.restriction_info?.[0]?.restriction_type || '').toUpperCase();
  const set = {};
  if (ev.field === 'account_update' && RESTRICT.has(event)) set.connectionStatus = 'restricted';
  if (ev.field === 'account_update' && REMOVED.has(event)) { set.connectionStatus = 'disconnected'; set.automationEnabled = false; set.acceptOrdersEnabled = false; }
  if (v.current_limit || v.event === 'FLAGGED' || v.current_quality_rating) set['meta.phone'] = { ...(integ.meta?.phone || {}), ...(v.current_limit ? { messaging_limit_tier: v.current_limit } : {}), ...(v.current_quality_rating ? { quality_rating: v.current_quality_rating } : {}), updatedByWebhook: new Date() };
  if (!Object.keys(set).length) return;
  if (set.connectionStatus) set.lastError = { at: new Date(), code: event, message: `Meta reported: ${event.replace(/_/g, ' ').toLowerCase()}.` };
  await WhatsAppIntegration.updateOne({ _id: integ._id }, { $set: set });
}

/** Entry point: `ev` is one item from parseWebhook(). */
export async function processEvent(ev) {
  const integ = await WhatsAppIntegration.findOne(ev.phoneNumberId ? { phoneNumberId: ev.phoneNumberId } : { wabaId: ev.wabaId }).lean();
  if (!integ || integ.connectionStatus === 'not_connected') return { ignored: true }; // unknown number: never create anything for it
  await WhatsAppIntegration.updateOne({ _id: integ._id }, { lastWebhookReceivedAt: new Date() });
  if (ev.kind === 'message') return onMessage(ev, integ);
  if (ev.kind === 'status') return applyStatus(ev.status);
  if (ev.kind === 'echo') return onEcho(ev, integ);
  return onAccount(ev, integ);
}
