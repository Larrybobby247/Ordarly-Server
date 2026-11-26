// WhatsApp message shapes: everything that is read from, or written to, Meta's webhook and send API. Pure functions, unit-tested.
// Limits below are Meta's interactive-message limits (checked against the current Cloud API docs): text body 4096; interactive body 1024;
// reply button title 20 (max 3 buttons); list button label 20, row title 24, row description 72 (max 10 rows in total).
import crypto from 'crypto';

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const clipBody = (s, n) => { s = String(s ?? '').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }; // keeps line breaks

/* ---------- webhook security ---------- */
/** Meta signs every webhook: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(raw request body, app secret). Compared in constant time. */
export function verifySignature(rawBody, header, appSecret) {
  if (!appSecret || !header || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const want = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const got = header.slice(7);
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
export function verifyChallenge(query, expectedToken) {
  const given = String(query['hub.verify_token'] ?? '');
  const ok = query['hub.mode'] === 'subscribe' && !!expectedToken && given.length === expectedToken.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expectedToken));
  return ok ? String(query['hub.challenge'] ?? '') : null;
}

/* ---------- reading webhooks ---------- */
/** A customer is identified by phone number when Meta gives one, otherwise by Meta's business-scoped user id. */
export function customerIdentity(contact, msg) {
  const waId = String(contact?.wa_id || msg?.from || '').replace(/\D/g, '');
  const userId = contact?.user_id || msg?.from_user_id || null;
  if (waId) return { key: waId, phone: waId, name: contact?.profile?.name || null };
  if (userId) return { key: `bsuid:${userId}`, phone: null, userId, name: contact?.profile?.name || contact?.profile?.username || null };
  return null;
}

/** Turns one inbound Meta message into the small shape the conversation engine understands. */
export function normalizeInbound(msg) {
  const base = { id: msg.id, type: msg.type, timestamp: msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date(), text: '', buttonId: null, location: null };
  switch (msg.type) {
    case 'text': return { ...base, text: String(msg.text?.body || '').slice(0, 2000) };
    case 'interactive': {
      const i = msg.interactive || {};
      const r = i.button_reply || i.list_reply || {};
      return { ...base, buttonId: r.id ? String(r.id).slice(0, 200) : null, text: String(r.title || '').slice(0, 200) };
    }
    case 'button': return { ...base, buttonId: msg.button?.payload ? String(msg.button.payload).slice(0, 200) : null, text: String(msg.button?.text || '').slice(0, 200) };
    case 'location': {
      const lat = Number(msg.location?.latitude), lng = Number(msg.location?.longitude);
      const ok = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      return { ...base, location: ok ? { lat, lng, name: msg.location?.name ? String(msg.location.name).slice(0, 120) : null, address: msg.location?.address ? String(msg.location.address).slice(0, 200) : null } : null };
    }
    default: return { ...base, type: ['image', 'audio', 'video', 'document', 'sticker', 'contacts', 'reaction', 'order'].includes(msg.type) ? msg.type : 'unsupported' };
  }
}

/** Readable one-liner for the inbox. */
export const previewOf = (n) => (n.type === 'text' ? n.text : n.buttonId ? `[Chose] ${n.text || n.buttonId}` : n.type === 'location' ? '[Shared a location]' : `[${n.type} message]`);

/**
 * Flattens a webhook body into independent events, each with a stable `key` for de-duplication.
 * kinds: message | status | echo | account (anything else about the account or number).
 */
export function parseWebhook(body) {
  const events = [];
  if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return events;
  for (const entry of body.entry) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const base = { wabaId: String(entry.id || ''), phoneNumberId: v.metadata?.phone_number_id ? String(v.metadata.phone_number_id) : null, field: ch.field };
      if (ch.field === 'messages') {
        for (const m of v.messages || []) {
          if (!m?.id) continue;
          const contact = (v.contacts || []).find((c) => c.wa_id === m.from || (c.user_id && c.user_id === m.from_user_id)) || v.contacts?.[0];
          events.push({ ...base, kind: 'message', key: `in:${m.id}`, message: m, contact });
        }
        for (const s of v.statuses || []) {
          if (!s?.id || !s.status) continue;
          events.push({ ...base, kind: 'status', key: `st:${s.id}:${s.status}:${s.timestamp || ''}`, status: s });
        }
      } else if (ch.field === 'smb_message_echoes') {
        for (const m of v.message_echoes || []) if (m?.id) events.push({ ...base, kind: 'echo', key: `echo:${m.id}`, echo: m });
      } else {
        const stable = crypto.createHash('sha256').update(JSON.stringify([ch.field, v])).digest('hex').slice(0, 24);
        events.push({ ...base, kind: 'account', key: `acct:${entry.id}:${ch.field}:${stable}`, value: v });
      }
    }
  }
  return events;
}

/* ---------- building outbound messages ---------- */
// Each builder returns { type, payload, preview }: `payload` goes to Meta (the sender adds messaging_product and the recipient), `preview` is what the inbox shows.
export const text = (body) => ({ type: 'text', payload: { type: 'text', text: { body: clipBody(body, 4096), preview_url: true } }, preview: clipBody(body, 4096) });

export function buttons(body, list) {
  const bs = list.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: String(b.id).slice(0, 256), title: clip(b.title, 20) } }));
  return { type: 'interactive', payload: { type: 'interactive', interactive: { type: 'button', body: { text: clipBody(body, 1024) }, action: { buttons: bs } } }, preview: `${clipBody(body, 1024)}\n[${list.slice(0, 3).map((b) => clip(b.title, 20)).join(' | ')}]` };
}

/** rows: [{ id, title, description? }] (at most 10 in total). */
export function list(body, buttonLabel, rows, sectionTitle = 'Options') {
  const rs = rows.slice(0, 10).map((r) => ({ id: String(r.id).slice(0, 200), title: clip(r.title, 24), ...(r.description ? { description: clip(r.description, 72) } : {}) }));
  return {
    type: 'interactive',
    payload: { type: 'interactive', interactive: { type: 'list', body: { text: clipBody(body, 1024) }, action: { button: clip(buttonLabel, 20), sections: [{ title: clip(sectionTitle, 24), rows: rs }] } } },
    preview: `${clipBody(body, 1024)}\n${rs.map((r, i) => `${i + 1}. ${r.title}${r.description ? ` - ${r.description}` : ''}`).join('\n')}`,
  };
}

/** "Share location" button: WhatsApp's own location-request message. */
export const locationRequest = (body) => ({ type: 'interactive', payload: { type: 'interactive', interactive: { type: 'location_request_message', body: { text: clipBody(body, 1024) }, action: { name: 'send_location' } } }, preview: `${clipBody(body, 1024)}\n[Share location]` });

export const ctaUrl = (body, label, url) => ({ type: 'interactive', payload: { type: 'interactive', interactive: { type: 'cta_url', body: { text: clipBody(body, 1024) }, action: { name: 'cta_url', parameters: { display_text: clip(label, 20), url } } } }, preview: `${clipBody(body, 1024)}\n[${clip(label, 20)}] ${url}` });

export const image = (link, caption) => ({ type: 'image', payload: { type: 'image', image: { link, ...(caption ? { caption: clipBody(caption, 1024) } : {}) } }, preview: `[Photo] ${clipBody(caption || '', 1024)}` });

export const template = (name, language, params, preview) => ({
  type: 'template',
  payload: { type: 'template', template: { name, language: { code: language }, components: params?.length ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: clip(p, 200) })) }] : [] } },
  preview: preview || `[Template: ${name}]`,
});

/** The full request body for Meta's /messages endpoint. Customers with a phone number are addressed by `to`, username-only customers by their business-scoped id. */
export function toMetaRequest(waKey, built) {
  const target = String(waKey).startsWith('bsuid:') ? { recipient: String(waKey).slice(6) } : { to: String(waKey) };
  return { messaging_product: 'whatsapp', recipient_type: 'individual', ...target, ...built.payload };
}
