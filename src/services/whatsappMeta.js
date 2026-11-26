// The few Meta Graph API calls the on/off controls need. (Embedded Signup, sending and billing calls belong to the later WhatsApp phases.)
import { decryptToken } from './tokenVault.js';

/**
 * Stops Meta sending this restaurant's WhatsApp events to Ordarly: removes our app's subscription from THEIR WhatsApp Business Account.
 * Best effort: it never throws. The caller disconnects locally either way and tells the owner when Meta could not be reached, so they can
 * also remove Ordarly under Business Integrations in Meta Business Settings.
 * (We deliberately do not revoke the whole Facebook login: the same person may have authorised Ordarly for another business too.)
 */
export async function unsubscribeApp({ wabaId, encryptedAccessToken }) {
  const version = process.env.META_API_VERSION; // never hard-coded: Meta retires API versions
  if (!wabaId || !encryptedAccessToken) return { ok: false, note: 'No Meta authorisation was stored for this connection.' };
  if (!version) return { ok: false, note: 'META_API_VERSION is not set on the server.' };
  try {
    const token = decryptToken(encryptedAccessToken);
    const res = await fetch(`https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success !== false) return { ok: true };
    console.error('[whatsapp] unsubscribe failed', res.status, data?.error?.code || '');
    return { ok: false, note: 'Meta did not confirm the removal.' };
  } catch (e) {
    console.error('[whatsapp] unsubscribe error', e.name); // no token or message body in the log
    return { ok: false, note: 'Meta could not be reached.' };
  }
}

/* ======================= Embedded Signup and account information ======================= */
const base = () => {
  const v = process.env.META_API_VERSION;
  if (!v) throw Object.assign(new Error('META_API_VERSION is not set on the server.'), { status: 503 });
  return `https://graph.facebook.com/${encodeURIComponent(v)}`;
};
export const metaConfigured = () => !!(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_API_VERSION && process.env.META_TOKEN_ENCRYPTION_KEY);

async function graph(path, { token, method = 'GET', body, query } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const res = await fetch(`${base()}${path}${qs}`, {
    method, signal: AbortSignal.timeout(15000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || 'Meta request failed'), { status: res.status, metaCode: data?.error?.code, metaSubcode: data?.error?.error_subcode });
  return data;
}

/** Exchanges the one-time code from the Embedded Signup popup for the business access token. Server-side only: the app secret never leaves here. */
export async function exchangeCode(code) {
  const d = await graph('/oauth/access_token', { query: { client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, code } });
  if (!d.access_token) throw new Error('Meta did not return an access token.');
  return { accessToken: d.access_token, expiresIn: Number(d.expires_in) || null };
}

/** Reads the phone number and checks it really belongs to the WABA the popup reported (never trust ids sent by the browser alone). */
export async function loadPhone({ token, wabaId, phoneNumberId }) {
  const list = await graph(`/${encodeURIComponent(wabaId)}/phone_numbers`, { token, query: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,platform_type,throughput,messaging_limit_tier,status' } });
  const phone = (list.data || []).find((p) => String(p.id) === String(phoneNumberId));
  if (!phone) throw Object.assign(new Error('That phone number does not belong to the WhatsApp Business Account that was authorised.'), { status: 400 });
  return phone;
}

/** Tells Meta to send this WABA's events to Ordarly's webhook (the callback URL and verify token are set once on the app in the Meta dashboard). */
export async function subscribeApp({ token, wabaId }) {
  const d = await graph(`/${encodeURIComponent(wabaId)}/subscribed_apps`, { token, method: 'POST' });
  if (d.success === false) throw new Error('Meta did not confirm the webhook subscription.');
  return true;
}

/** Registers a NEW number for the Cloud API. Not used for coexistence numbers, which are already registered through the WhatsApp Business app. */
export async function registerPhone({ token, phoneNumberId, pin }) {
  return graph(`/${encodeURIComponent(phoneNumberId)}/register`, { token, method: 'POST', body: { messaging_product: 'whatsapp', pin } });
}

/**
 * Billing / limit information, exactly as Meta returns it. A field Meta does not return stays null and the dashboard prints "Not available from Meta."
 * Nothing here is calculated, estimated or hard-coded (no free allowance, no prices).
 */
export async function metaSnapshot({ token, wabaId, phoneNumberId }) {
  const out = { fetchedAt: new Date(), phone: null, waba: null, pricing: null, error: null };
  const tryGet = async (fn) => { try { return await fn(); } catch (e) { out.error = out.error || e.message; return null; } };
  out.phone = await tryGet(() => graph(`/${encodeURIComponent(phoneNumberId)}`, { token, query: { fields: 'display_phone_number,verified_name,quality_rating,messaging_limit_tier,status,name_status,platform_type,throughput,account_mode' } }));
  out.waba = await tryGet(() => graph(`/${encodeURIComponent(wabaId)}`, { token, query: { fields: 'name,currency,account_review_status,business_verification_status,health_status' } }));
  // Conversation/pricing analytics for the last 30 days; Meta may not return it for every account.
  const end = Math.floor(Date.now() / 1000), start = end - 30 * 86400;
  out.pricing = await tryGet(() => graph(`/${encodeURIComponent(wabaId)}`, { token, query: { fields: `pricing_analytics.start(${start}).end(${end}).granularity(DAILY).dimensions(["PRICING_CATEGORY"])` } }));
  return out;
}

/** Creates the utility template used for order updates after the 24-hour window. Meta reviews it; until it is APPROVED it cannot be sent. */
export async function createOrderUpdateTemplate({ token, wabaId, name = 'ordarly_order_update' }) {
  return graph(`/${encodeURIComponent(wabaId)}/message_templates`, { token, method: 'POST', body: {
    name, language: 'en', category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Update on your order {{1}} from {{2}}: {{3}}.', example: { body_text: [['ORD-AB12CD34', 'Your restaurant', 'is being prepared']] } }],
  } });
}
export async function listTemplates({ token, wabaId }) {
  const d = await graph(`/${encodeURIComponent(wabaId)}/message_templates`, { token, query: { fields: 'name,status,language,category', limit: '50' } });
  return d.data || [];
}
