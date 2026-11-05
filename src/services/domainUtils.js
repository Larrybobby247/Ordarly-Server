// Pure helpers for custom domains (no database, no network) so they are easy to unit-test.
import net from 'net';

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TLD = /^(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})$/;

/** Lowercase hostname without scheme, path, port, credentials or trailing dot. Returns '' when nothing usable is left. */
export function cleanHostInput(raw = '') {
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.replace(/[/?#].*$/, '');                // path, query, hash
  s = s.replace(/^.*@/, '');                    // user:pass@
  s = s.replace(/:\d+$/, '');                   // port
  s = s.replace(/\.+$/, '');                    // trailing dot
  return s;
}

/**
 * Validate a hostname a restaurant wants to use. Returns { ok: true, domain, apex, isApex } or { ok: false, error }.
 * `reserved` is a list of hostnames (e.g. the platform domain) that are never allowed, together with all of their subdomains.
 */
export function validateCustomDomain(raw, { reserved = [] } = {}) {
  const domain = cleanHostInput(raw);
  if (!domain) return { ok: false, error: 'Enter a domain, e.g. order.myrestaurant.com' };
  if (domain.length > 253) return { ok: false, error: 'That domain is too long.' };
  if (/\s/.test(domain) || /[^a-z0-9.-]/.test(domain)) return { ok: false, error: 'Domain names can only contain letters, numbers, dots and hyphens. Internationalised names must be entered in their xn-- form.' };
  if (net.isIP(domain)) return { ok: false, error: 'IP addresses cannot be used. Enter a domain name.' };
  if (domain === 'localhost' || domain.endsWith('.localhost')) return { ok: false, error: 'localhost cannot be used.' };
  const labels = domain.split('.');
  if (labels.length < 2) return { ok: false, error: 'Enter a full domain such as restaurant.com or order.restaurant.com.' };
  if (labels.some((l) => !LABEL.test(l))) return { ok: false, error: 'That domain is not valid. Check for empty parts, leading or trailing hyphens.' };
  if (!TLD.test(labels[labels.length - 1])) return { ok: false, error: 'That domain does not end in a valid extension such as .com or .com.ng.' };
  const blockedSuffix = ['vercel.app', 'vercel.sh', 'vercel.dev', 'now.sh', 'onrender.com', 'netlify.app', 'local', 'internal', 'test', 'example', 'invalid'];
  if (blockedSuffix.some((s) => domain === s || domain.endsWith('.' + s))) return { ok: false, error: 'Hosting-provider addresses cannot be used. Enter a domain you own.' };
  for (const r of reserved.map(cleanHostInput).filter(Boolean)) {
    if (domain === r || domain.endsWith('.' + r) || r.endsWith('.' + domain)) return { ok: false, error: 'That domain is reserved.' };
  }
  const apex = apexOf(domain);
  return { ok: true, domain, apex, isApex: domain === apex };
}

// Public suffixes that have a registrable label below them (the common Nigerian ones plus the usual second-level ones).
// Anything not listed is treated as a single-label TLD. Used only to decide which DNS records to show; Vercel's answer wins.
const SECOND_LEVEL = new Set(['com.ng', 'org.ng', 'net.ng', 'edu.ng', 'gov.ng', 'sch.ng', 'name.ng', 'mobi.ng', 'ng.com',
  'co.uk', 'org.uk', 'ac.uk', 'co.za', 'org.za', 'com.au', 'net.au', 'co.ke', 'or.ke', 'com.gh', 'co.in', 'com.br', 'co.nz']);

/** Registrable domain: "order.foodhub.com.ng" -> "foodhub.com.ng". */
export function apexOf(domain) {
  const labels = domain.split('.');
  const last2 = labels.slice(-2).join('.');
  const n = SECOND_LEVEL.has(last2) ? 3 : 2;
  return labels.slice(-n).join('.');
}

export const isApexDomain = (domain) => apexOf(domain) === domain;

/** Hostnames that are the Ordarly app itself (never custom domains). */
export function platformHosts() {
  const hosts = new Set();
  const add = (v) => { const h = cleanHostInput(v); if (h) { hosts.add(h); hosts.add(h.startsWith('www.') ? h.slice(4) : 'www.' + h); } };
  add(process.env.PLATFORM_DOMAIN);
  add(process.env.CLIENT_URL);
  add('ordarly.com.ng');
  return hosts;
}
export const isPlatformHost = (host) => platformHosts().has(cleanHostInput(host));

/** Hostnames that must never be treated as customer domains even if someone submits them. */
export const reservedHosts = () => [...platformHosts()].map((h) => h.replace(/^www\./, '')).filter((v, i, a) => a.indexOf(v) === i);

/** Flatten the chunked strings DNS returns for TXT records. */
export const flattenTxt = (records = []) => records.map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));

const TEMP_DNS = new Set(['ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EREFUSED']);
const MISSING_DNS = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);
export const classifyDnsError = (e) => (MISSING_DNS.has(e?.code) ? 'missing' : TEMP_DNS.has(e?.code) ? 'temporary' : 'temporary');

/**
 * Turn a Vercel "domain config" response into the DNS records we show the customer.
 * Records come from Vercel's own recommendations; nothing here is hardcoded except which TYPE suits apex vs subdomain.
 */
export function routingRecords(domain, config) {
  const apex = isApexDomain(domain);
  const byRank = (a, b) => (a.rank ?? 99) - (b.rank ?? 99);
  const cname = [...(config?.recommendedCNAME || [])].sort(byRank)[0]?.value;
  const ipv4 = [...(config?.recommendedIPv4 || [])].sort(byRank)[0]?.value;
  const ips = Array.isArray(ipv4) ? ipv4 : ipv4 ? [ipv4] : [];
  const out = [];
  if (apex) {
    if (ips.length) for (const ip of ips) out.push({ type: 'A', host: domain, hostLabel: '@', value: ip, purpose: 'routing' });
    else if (cname) out.push({ type: 'ALIAS/ANAME', host: domain, hostLabel: '@', value: cname, purpose: 'routing', note: 'Use ALIAS or ANAME if your DNS provider offers it. Otherwise use an A record.' });
  } else if (cname) {
    out.push({ type: 'CNAME', host: domain, hostLabel: domain.slice(0, domain.length - apexOf(domain).length - 1), value: cname, purpose: 'routing' });
  } else if (ips.length) {
    for (const ip of ips) out.push({ type: 'A', host: domain, hostLabel: domain.slice(0, domain.length - apexOf(domain).length - 1), value: ip, purpose: 'routing' });
  }
  return out;
}

/** Does a CNAME/A answer point at Vercel? Compares to the targets Vercel recommended (trailing dots and case ignored). */
export const sameTarget = (a, b) => String(a).toLowerCase().replace(/\.$/, '') === String(b).toLowerCase().replace(/\.$/, '');
