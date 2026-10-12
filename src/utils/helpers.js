import crypto from 'crypto';
import { z } from 'zod';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
export const orderRef = () => 'ORD-' + crypto.randomBytes(4).toString('hex').toUpperCase();

export const slugify = (s) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Normalise a Nigerian number to digits with country code, e.g. 08012345678 -> 2348012345678 */
export function normalisePhone(raw = '') {
  let d = String(raw).replace(/\D/g, '');
  if (d.startsWith('0') && d.length === 11) d = '234' + d.slice(1);
  return d;
}
export const validWhatsapp = (n) => /^\d{10,15}$/.test(n || '');

export const validate = (schema) => (req, res, next) => {
  const r = schema.safeParse(req.body);
  if (!r.success) return res.status(400).json({ error: r.error.issues[0].message, issues: r.error.issues });
  req.body = r.data;
  next();
};

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export { z };

export const naira = (n) => '₦' + Number(n || 0).toLocaleString('en-NG');

/** Lowercase, trimmed, single-spaced neighbourhood key used for storing and matching delivery areas. */
export const normalizeArea = (s = '') =>
  String(s).toLowerCase().replace(/[^a-z0-9\s\-'./]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
