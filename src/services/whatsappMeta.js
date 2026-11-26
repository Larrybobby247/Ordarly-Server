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
