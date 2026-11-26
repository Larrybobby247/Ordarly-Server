// WhatsApp on/off controls: the database side. The rules live in whatsappControls.js.
// Every guard below reads the CURRENT record from the database (no caching) so a change made in the dashboard applies to the very next send.
import { WhatsAppIntegration, WhatsAppControlLog } from '../models/index.js';
import { planControlChange, planDisconnect, guardAutomatedSend, guardManualSend, guardOrderCreation, inboundMode } from './whatsappControls.js';
import { unsubscribeApp } from './whatsappMeta.js';

export const getIntegration = (restaurantId) => WhatsAppIntegration.findOne({ restaurant: restaurantId }).lean();

/* ---------- guards: call these immediately before acting ---------- */
/** Before EVERY automated outbound message. Pass the epoch the message was queued under, and when the customer's message arrived. */
export async function canSendAutomated(restaurantId, opts) { return guardAutomatedSend(await getIntegration(restaurantId), opts); }
/** Before a staff reply sent through the Ordarly inbox (not automation). */
export async function canSendManual(restaurantId) { return guardManualSend(await getIntegration(restaurantId)); }
/** Before creating any NEW WhatsApp order (checkout confirmation, payment link, order creation). */
export async function canCreateOrder(restaurantId) { return guardOrderCreation(await getIntegration(restaurantId)); }
/** What to do with a customer message that just arrived. */
export async function modeForInbound(restaurantId, opts) { return inboundMode(await getIntegration(restaurantId), opts); }
/** The epoch to store on an automated message when it is queued. */
export async function currentEpoch(restaurantId) { return (await getIntegration(restaurantId))?.automationEpoch || 0; }

/* ---------- changes ---------- */
const stampKeys = (set, actor, now) => {
  for (const k of Object.keys(set)) if (k.startsWith('changes.')) set[k] = { at: now, by: actor._id, byName: actor.name };
  return set;
};
const same = (v) => (v === undefined ? { $exists: false } : v); // "the value is still what we read", including "still missing"
const logs = (restaurant, changes, actor, note) => changes.map((c) => ({ restaurant, control: c.control, from: c.from, to: c.to, by: actor._id, byName: actor.name, note }));

/**
 * Switch automation and/or order acceptance. The write is conditional on the values we just read, so two people clicking at the same moment
 * cannot overwrite each other (the loser re-reads and re-plans). Resolves to { integration, changed } or { error, code }.
 */
export async function updateControls(restaurantId, patch, actor) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = (await getIntegration(restaurantId)) || (await WhatsAppIntegration.findOneAndUpdate({ restaurant: restaurantId }, { $setOnInsert: { restaurant: restaurantId } }, { upsert: true, new: true }).lean());
    const plan = planControlChange(cur, patch);
    if (plan.error) return plan;
    if (!plan.changes.length) return { integration: cur, changed: [] };
    const now = new Date();
    const hit = await WhatsAppIntegration.findOneAndUpdate(
      { _id: cur._id, connectionStatus: cur.connectionStatus, automationEpoch: same(cur.automationEpoch), automationEnabled: same(cur.automationEnabled), acceptOrdersEnabled: same(cur.acceptOrdersEnabled) },
      { $set: stampKeys(plan.set, actor, now) }, { new: true },
    ).lean();
    if (hit) { await WhatsAppControlLog.insertMany(logs(restaurantId, plan.changes, actor)); return { integration: hit, changed: plan.changes }; }
  }
  return { error: 'Your WhatsApp settings were changed by someone else at the same moment. Please try again.', code: 'CONFLICT', status: 409 };
}

/**
 * Disconnect. Asks Meta to stop sending this restaurant's events (best effort), wipes the stored token, and switches everything off.
 * Nothing historical is deleted: conversations, messages, orders and credit transactions are separate records and are not touched.
 */
export async function disconnect(restaurantId, actor) {
  const cur = await WhatsAppIntegration.findOne({ restaurant: restaurantId }).select('+encryptedAccessToken').lean();
  if (!cur || ['not_connected', 'disconnected'].includes(cur.connectionStatus)) return { error: 'WhatsApp is not connected.', code: 'NOT_CONNECTED', status: 409 };
  const meta = await unsubscribeApp(cur); // never throws
  const plan = planDisconnect(cur); const now = new Date();
  const integration = await WhatsAppIntegration.findOneAndUpdate({ _id: cur._id }, { $set: stampKeys(plan.set, actor, now) }, { new: true }).lean();
  await WhatsAppControlLog.insertMany(logs(restaurantId, plan.changes, actor, meta.ok ? 'Meta subscription removed' : `Meta not confirmed: ${meta.note}`));
  return { integration, changed: plan.changes, metaRevoked: meta.ok, metaNote: meta.ok ? null : meta.note };
}

export const controlHistory = (restaurantId, limit = 20) => WhatsAppControlLog.find({ restaurant: restaurantId }).sort('-createdAt').limit(limit).select('control from to byName note createdAt').lean();
