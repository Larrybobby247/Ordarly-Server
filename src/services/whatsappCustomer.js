// Customer details collected in the WhatsApp chat: validation and formatting only (pure). Saved details come from the restaurant's OWN
// previous orders for the same verified WhatsApp number (see whatsappInbound.js); no separate customer database is created.

/** A person's full name: 2-60 characters, letters with spaces . ' - only, at least one letter. Digits, links and symbols are rejected. */
export function validName(raw) {
  const n = String(raw || '').replace(/\s+/g, ' ').trim();
  if (n.length < 2 || n.length > 60) return null;
  if (!/^[\p{L}][\p{L}\p{M}.'’\- ]*$/u.test(n)) return null;
  if (!/\p{L}.*\p{L}/u.test(n)) return null;
  return n.split(' ').map((w) => (w === w.toLowerCase() || w === w.toUpperCase() ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w)).join(' ');
}

/** 2348012345678 -> 08012345678 (how Nigerians read it); other countries are shown with a plus sign. */
export function displayPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (/^234\d{10}$/.test(d)) return '0' + d.slice(3);
  return d ? '+' + d : '';
}

/** A phone number a customer typed -> digits in international form (Nigeria's 0 prefix handled), or null if it is not a plausible number. */
export function cleanPhone(raw) {
  let d = String(raw || '').replace(/[\s().-]/g, '');
  if (!/^\+?\d{10,15}$/.test(d)) return null;
  d = d.replace(/^\+/, '');
  if (/^0\d{10}$/.test(d)) d = '234' + d.slice(1);
  else if (/^\d{10}$/.test(d) && /^[789]/.test(d)) d = '234' + d;     // 8012345678 -> Nigerian mobile without the leading 0
  if (/^234\d+$/.test(d) && d.length !== 13) return null;
  return /^\d{10,15}$/.test(d) ? d : null;
}

/** The ways one number may have been stored on earlier orders (0801…, 234801…, +234801…). */
export function phoneVariants(p) {
  const d = String(p || '').replace(/\D/g, ''); if (!d) return [];
  const out = new Set([d, '+' + d]);
  if (/^234\d{10}$/.test(d)) { out.add('0' + d.slice(3)); out.add(d.slice(3)); }
  return [...out];
}
