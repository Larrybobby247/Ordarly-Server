import { EmailLog } from '../models/index.js';

const BRAND = 'Ordarly';
const wrap = (title, body) => `<div style="font-family:Inter,Arial,sans-serif;background:#f6faf6;padding:24px">
<div style="max-width:560px;margin:auto;background:#fff;border-radius:16px;padding:28px;border:1px solid #e5efe5">
<div style="font-weight:800;color:#16a34a;font-size:20px;margin-bottom:16px">${BRAND}</div>
<h2 style="margin:0 0 12px;color:#0f172a">${title}</h2>${body}
<p style="color:#94a3b8;font-size:12px;margin-top:28px">Sent by ${BRAND}.</p></div></div>`;

export const btn = (href, label) =>
  `<p><a href="${href}" style="background:#16a34a;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;display:inline-block;font-weight:600">${label}</a></p>`;

async function deliver(log) {
  const key = process.env.RESEND_API_KEY;
  log.attempts += 1;
  try {
    if (!key) throw new Error('RESEND_API_KEY not configured - email not sent');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM, to: [log.to],
        subject: log.payload.subject, html: log.payload.html,
        ...(log.payload.replyTo ? { reply_to: log.payload.replyTo } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Provider HTTP ${res.status}`);
    // "accepted" = provider accepted for processing. NOT proof of inbox delivery.
    log.status = 'accepted';
    log.providerId = data.id;
    log.lastError = undefined;
  } catch (e) {
    log.status = 'failed';
    log.lastError = e.message;
  }
  await log.save();
  return log;
}

/** Queue + attempt an email. Never throws: email failure must never lose an order. */
export async function sendEmail({ to, type, subject, title, body, dedupeKey, restaurant, order, replyTo }) {
  try {
    if (!to) return null;
    if (dedupeKey) {
      const existing = await EmailLog.findOne({ dedupeKey });
      if (existing) return existing; // idempotent: repeated webhooks don't re-send
    }
    const log = await EmailLog.create({
      to, type, dedupeKey, restaurant, order,
      payload: { subject, html: wrap(title || subject, body), replyTo },
    });
    return await deliver(log);
  } catch (e) {
    console.error('[email] enqueue failed', e.message);
    return null;
  }
}

/** Retry failed emails (called by cron). Max 5 attempts. */
export async function retryFailedEmails() {
  const failed = await EmailLog.find({ status: 'failed', attempts: { $lt: 5 } }).limit(50);
  for (const log of failed) await deliver(log);
}

/** Manual retry from the admin panel. */
export async function retryEmailById(id) {
  const log = await EmailLog.findById(id);
  if (!log || !log.payload) return null;
  return deliver(log);
}
