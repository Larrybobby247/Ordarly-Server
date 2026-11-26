// Every outbound WhatsApp message goes through here: queued in the database, checked again right before sending, then sent to Meta.
//
// Order of checks at send time (each reads FRESH data, so a dashboard change applies to the very next send):
//   1. connection / suspension / automation switch / queue epoch (whatsappControls)   2. human handover   3. 24-hour customer window
//   4. Ordarly credit (reserve one; settled only when Meta reports "delivered")       5. send, classify any error, retry or give up.
import { WhatsAppMessage, WhatsAppConversation, WhatsAppIntegration } from '../models/index.js';
import { getIntegration } from './whatsappControlsStore.js';
import { guardAutomatedSend, guardManualSend } from './whatsappControls.js';
import { toMetaRequest } from './whatsappPayloads.js';
import { classifyMetaError, needsOwnerAction, backoffMs, MAX_ATTEMPTS } from './whatsappErrors.js';
import { decryptToken } from './tokenVault.js';
import { reserveCredit, settleCredit, releaseCredit } from './whatsappCredits.js';
import { notifyRestaurant } from './notify.js';

const WINDOW_MS = 24 * 3600000;
const isDup = (e) => e?.code === 11000;
const RANK = { pending: 0, sent: 1, delivered: 2, read: 3 };

/**
 * Queue one outbound message. `built` comes from a builder in whatsappPayloads.js.
 * opts: { automated, origin, user, dedupeKey, epoch, inboundAt, allowDuringHuman, creditExempt, exemptReason, templateFallback, category }
 * A repeated dedupeKey returns the existing message (nothing is queued twice). Starts sending straight away without waiting for the minute job.
 */
export async function enqueue(conversation, built, opts = {}) {
  const row = {
    restaurant: conversation.restaurant, conversation: conversation._id, customerWaId: conversation.customerWaId, direction: 'outbound',
    messageType: built.type, content: built.preview, payload: built.payload, origin: opts.origin || (opts.automated ? 'bot' : 'staff'),
    sentByUser: opts.user?._id, sentByName: opts.user?.name, automated: !!opts.automated, sendStatus: 'queued', deliveryStatus: 'pending',
    nextAttemptAt: opts.at || new Date(), dedupeKey: opts.dedupeKey, epoch: opts.epoch, inboundAt: opts.inboundAt,
    templateFallback: opts.templateFallback, allowDuringHuman: !!opts.allowDuringHuman,
    creditExempt: !!opts.creditExempt, exemptReason: opts.exemptReason, order: opts.order, orderEvent: opts.orderEvent, messageCategory: opts.category || (opts.templateFallback ? 'utility' : 'service'),
  };
  let msg;
  try { msg = await WhatsAppMessage.create(row); }
  catch (e) { if (isDup(e)) return WhatsAppMessage.findOne({ restaurant: conversation.restaurant, dedupeKey: opts.dedupeKey }); throw e; }
  await WhatsAppConversation.updateOne({ _id: conversation._id }, { $set: { lastMessagePreview: built.preview?.slice(0, 140), lastMessageDirection: 'outbound', lastActivityAt: new Date() } });
  if (!opts.noKick) setImmediate(() => processMessage(msg._id).catch((e) => console.error('[whatsapp send]', e.message)));
  return msg; // with noKick the caller sends several messages in order by calling processMessage itself
}

async function finish(msg, set, release) {
  await WhatsAppMessage.updateOne({ _id: msg._id }, { $set: set });
  if (release) await releaseCredit(msg._id, release).catch(() => {});
}

/** Takes one queued message, runs the checks, sends it. Safe to call from several places: only one caller wins the claim. */
export async function processMessage(id) {
  const now = new Date();
  const msg = await WhatsAppMessage.findOneAndUpdate({ _id: id, sendStatus: 'queued', nextAttemptAt: { $lte: now } }, { $set: { sendStatus: 'sending', lockedAt: now }, $inc: { attempts: 1 } }, { new: true });
  if (!msg) return;
  const cancel = (reason, kind = 'cancelled') => finish(msg, { sendStatus: 'cancelled', deliveryStatus: 'failed', failureKind: kind, failureReason: reason }, 'cancelled');

  const integ = await getIntegration(msg.restaurant);
  const conv = await WhatsAppConversation.findById(msg.conversation).lean();
  if (!conv) return cancel('Conversation no longer exists.');

  // 1. Switches (fresh read)
  const guard = msg.automated ? guardAutomatedSend(integ, { epoch: msg.epoch, inboundAt: msg.inboundAt }) : guardManualSend(integ);
  if (!guard.ok) return cancel(guard.message, guard.reason);
  // 2. Handover: once a person is handling the chat the bot stays silent (except the single acknowledgement)
  if (msg.automated && !msg.allowDuringHuman && ['human_pending', 'human_active'].includes(conv.status)) return cancel('A team member is handling this conversation.', 'handover');

  // 3. 24-hour window: free-form messages need a customer message in the last 24 hours, otherwise only an approved template can be sent
  let payload = msg.payload, type = msg.messageType;
  const inWindow = conv.lastCustomerMessageAt && now - new Date(conv.lastCustomerMessageAt) < WINDOW_MS;
  if (!inWindow) {
    const t = msg.templateFallback;
    if (t?.payload) { payload = t.payload; type = 'template'; }
    else return finish(msg, { sendStatus: 'failed', deliveryStatus: 'failed', failureKind: 'window_closed', failureReason: 'The customer last wrote more than 24 hours ago, so only an approved template message can be sent.' }, 'window_closed');
  }

  // 4. Ordarly credit (not for the single "credits finished" notice, which is exempt so the customer is not left in silence)
  if (!msg.creditExempt) {
    const r = await reserveCredit(msg);
    if (!r.ok) return finish(msg, { sendStatus: 'failed', deliveryStatus: 'failed', failureKind: 'credits', failureReason: 'Ordarly message credits are finished.' });
  }

  // 5. Send
  const full = await WhatsAppIntegration.findById(integ._id).select('+encryptedAccessToken phoneNumberId').lean();
  const version = process.env.META_API_VERSION;
  if (!full?.encryptedAccessToken || !full.phoneNumberId || !version) return finish(msg, { sendStatus: 'failed', deliveryStatus: 'failed', failureKind: 'unknown', failureReason: 'WhatsApp is not fully set up on the server.' }, 'failed');
  let res, data;
  try {
    const body = toMetaRequest(conv.customerWaId, { type, payload });
    res = await fetch(`https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(full.phoneNumberId)}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${decryptToken(full.encryptedAccessToken)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    data = await res.json().catch(() => ({}));
  } catch { return failedAttempt(msg, integ, classifyMetaError({ network: true })); }

  const metaId = data?.messages?.[0]?.id;
  if (res.ok && metaId) {
    try { await WhatsAppMessage.updateOne({ _id: msg._id }, { $set: { sendStatus: 'sent', deliveryStatus: 'sent', metaMessageId: metaId, messageType: type }, $unset: { failureKind: 1, failureReason: 1, failureCode: 1 } }); }
    catch (e) { if (!isDup(e)) throw e; }
    // a status webhook may have arrived before we saved the id: nothing to do, applyStatus is idempotent and also looks messages up by id later
    return;
  }
  const err = data?.error || {};
  return failedAttempt(msg, integ, classifyMetaError({ httpStatus: res.status, code: err.code, details: err.error_data?.details || err.message }));
}

async function failedAttempt(msg, integ, c) {
  const give = !c.retry || msg.attempts >= MAX_ATTEMPTS;
  if (!give) { await WhatsAppMessage.updateOne({ _id: msg._id }, { $set: { sendStatus: 'queued', nextAttemptAt: new Date(Date.now() + backoffMs(msg.attempts)), failureKind: c.kind, failureReason: c.message, failureCode: c.code } }); return; }
  await finish(msg, { sendStatus: 'failed', deliveryStatus: 'failed', failureKind: c.kind, failureReason: c.message, failureCode: c.code }, c.kind);
  await recordIntegrationProblem(msg.restaurant, integ, c);
}

/** Meta problems that need the OWNER to act (expired token, payment, restriction, limit) are saved on the integration and notified once per kind per day. */
export async function recordIntegrationProblem(restaurantId, integ, c) {
  if (!needsOwnerAction(c.kind)) return;
  const now = new Date();
  const set = { lastError: { at: now, code: c.code, message: c.message } };
  if (c.integrationStatus && integ?.connectionStatus === 'connected') set.connectionStatus = c.integrationStatus;
  const prev = integ?.lastError;
  await WhatsAppIntegration.updateOne({ restaurant: restaurantId }, { $set: set });
  if (!prev?.at || prev.code !== c.code || now - new Date(prev.at) > 24 * 3600000)
    notifyRestaurant(restaurantId, { title: 'WhatsApp needs your attention', body: c.message.slice(0, 140), url: '/dashboard/whatsapp', tag: `wa-problem-${c.kind}` }).catch(() => {});
}

/**
 * Delivery receipts from Meta. Moves a message forward only (sent -> delivered -> read) so a late or repeated event can never move it back,
 * settles the credit on the first "delivered"/"read", and releases it on a permanent failure.
 */
export async function applyStatus(s) {
  const msg = await WhatsAppMessage.findOne({ metaMessageId: s.id });
  if (!msg) return { found: false };
  if (s.status === 'failed') {
    const e = s.errors?.[0] || {};
    const c = classifyMetaError({ code: e.code, details: e.error_data?.details || e.message || e.title });
    await WhatsAppMessage.updateOne({ _id: msg._id, deliveryStatus: { $in: ['pending', 'sent', 'unconfirmed'] } }, { $set: { deliveryStatus: 'failed', failureKind: c.kind, failureReason: c.message, failureCode: c.code } });
    await releaseCredit(msg._id, 'failed');
    await recordIntegrationProblem(msg.restaurant, await getIntegration(msg.restaurant), c);
    return { found: true, failed: true };
  }
  if (!(s.status in RANK) || s.status === 'pending') return { found: true };
  if (['delivered', 'read'].includes(s.status)) {
    await WhatsAppMessage.updateOne({ _id: msg._id, deliveryStatus: { $in: ['pending', 'sent', 'unconfirmed', 'failed'] } }, { $set: { deliveryStatus: s.status } });
    await WhatsAppMessage.updateOne({ _id: msg._id, deliveryStatus: 'delivered' }, { $set: { deliveryStatus: s.status } }).catch(() => {});
    if (s.status === 'read') await WhatsAppMessage.updateOne({ _id: msg._id, deliveryStatus: { $ne: 'read' } }, { $set: { deliveryStatus: 'read' } });
    if (!msg.creditExempt) await settleCredit(msg._id);
  } else if (s.status === 'sent') {
    await WhatsAppMessage.updateOne({ _id: msg._id, deliveryStatus: 'pending' }, { $set: { deliveryStatus: 'sent' } });
  }
  return { found: true };
}

/** Minute job: send what is due, free messages stuck in "sending" after a crash, and cancel anything left over for a number that was switched off. */
export async function drainQueue(limit = 50) {
  const now = new Date();
  await WhatsAppMessage.updateMany({ sendStatus: 'sending', lockedAt: { $lt: new Date(now - 2 * 60000) } }, { $set: { sendStatus: 'queued', nextAttemptAt: now } });
  const due = await WhatsAppMessage.find({ sendStatus: 'queued', nextAttemptAt: { $lte: now } }).sort('nextAttemptAt').limit(limit).select('_id').lean();
  for (const m of due) await processMessage(m._id).catch((e) => console.error('[whatsapp drain]', e.message));
  return due.length;
}
