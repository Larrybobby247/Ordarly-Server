// Encrypts Meta access tokens before they are stored (AES-256-GCM). The key is META_TOKEN_ENCRYPTION_KEY: 32 random bytes as 64 hex characters or base64.
// A token is only ever decrypted on the server, in memory, to call Meta. It is never logged and never sent to the browser.
import crypto from 'crypto';

function key() {
  const raw = process.env.META_TOKEN_ENCRYPTION_KEY || '';
  const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (k.length !== 32) throw Object.assign(new Error('META_TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64).'), { status: 503 });
  return k;
}

export function encryptToken(plain) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decryptToken(stored) {
  const [v, iv, tag, ct] = String(stored || '').split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unreadable stored token.');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
