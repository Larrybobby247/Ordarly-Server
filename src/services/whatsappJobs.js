// Background work for WhatsApp: process stored webhook events (with retries), send queued messages, and look after credits.
import { WhatsAppWebhookEvent } from '../models/index.js';
import { processEvent } from './whatsappInbound.js';
import { drainQueue } from './whatsappSender.js';
import { releaseStaleReservations, expirePurchasedCredits, reconcilePurchases, renewAllWallets } from './whatsappCredits.js';
import { ensureDefaultPackages } from './whatsappConfig.js';
import { backoffMs } from './whatsappErrors.js';

const MAX_EVENT_ATTEMPTS = 6;

/** Runs one stored event. Meta has already been answered with 200, so a failure here is retried later from our own database. */
export async function processStored(key) {
  const row = await WhatsAppWebhookEvent.findOneAndUpdate({ key, processed: false, $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: new Date() } }] }, { $set: { nextAttemptAt: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } }, { new: true });
  if (!row) return;
  try { await processEvent(row.payload); await WhatsAppWebhookEvent.updateOne({ _id: row._id }, { $set: { processed: true }, $unset: { lastError: 1 } }); }
  catch (e) {
    console.error('[whatsapp event]', row.key, e.message);
    await WhatsAppWebhookEvent.updateOne({ _id: row._id }, { $set: { lastError: String(e.message).slice(0, 300), nextAttemptAt: new Date(Date.now() + backoffMs(row.attempts)), processed: row.attempts >= MAX_EVENT_ATTEMPTS } });
  }
}

export async function retryEvents() {
  const due = await WhatsAppWebhookEvent.find({ processed: false, attempts: { $lt: MAX_EVENT_ATTEMPTS }, nextAttemptAt: { $lte: new Date() } }).sort('createdAt').limit(50).select('key').lean();
  for (const d of due) await processStored(d.key);
}

let lastHourly = 0;
/** Runs every minute from src/index.js. */
export async function runWhatsAppJobs() {
  await drainQueue();
  await retryEvents();
  await reconcilePurchases();
  await releaseStaleReservations();
  if (Date.now() - lastHourly > 3600000) { lastHourly = Date.now(); await expirePurchasedCredits(); await renewAllWallets(); }
}
export { ensureDefaultPackages };
