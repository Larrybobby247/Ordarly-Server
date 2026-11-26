// Meta's webhook for ALL restaurants (one URL: /api/whatsapp/webhook). Mounted in index.js BEFORE express.json because the signature is
// computed over the exact raw bytes. Nothing from a request is trusted until the signature is verified with the app secret.
import { Router, raw } from 'express';
import { verifySignature, verifyChallenge, parseWebhook } from '../services/whatsappPayloads.js';
import { WhatsAppWebhookEvent } from '../models/index.js';
import { processStored } from '../services/whatsappJobs.js';

const r = Router();

// Meta calls this once, when you press "Verify and save" in the app dashboard.
r.get('/', (req, res) => {
  const challenge = verifyChallenge(req.query, process.env.META_WEBHOOK_VERIFY_TOKEN);
  if (challenge === null) return res.sendStatus(403);
  res.type('text/plain').send(challenge);
});

r.post('/', raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const secret = process.env.META_APP_SECRET;
  if (!secret) { console.error('[whatsapp webhook] META_APP_SECRET is not set'); return res.sendStatus(503); }
  if (!Buffer.isBuffer(req.body) || !verifySignature(req.body, req.get('x-hub-signature-256'), secret)) return res.sendStatus(401);
  let body; try { body = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  const events = parseWebhook(body);
  const keys = [];
  for (const ev of events) {
    try { await WhatsAppWebhookEvent.create({ key: ev.key, phoneNumberId: ev.phoneNumberId, wabaId: ev.wabaId, field: ev.field, payload: ev }); keys.push(ev.key); }
    catch (e) { if (e?.code !== 11000) { console.error('[whatsapp webhook] store failed', e.message); return res.sendStatus(500); } } // 500 makes Meta retry; a duplicate is simply skipped
  }
  res.sendStatus(200); // answer fast; the work happens after
  setImmediate(async () => { for (const k of keys) await processStored(k); });
});

export default r;
