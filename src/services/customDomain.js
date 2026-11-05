// Custom-domain lifecycle on top of MongoDB: register, check, disconnect, background worker, hostname lookups for CORS and routing.
import { Restaurant, User } from '../models/index.js';
import { randomToken } from '../utils/helpers.js';
import * as V from './vercel.js';
import { validateCustomDomain, reservedHosts, cleanHostInput, isPlatformHost, routingRecords, apexOf } from './domainUtils.js';
import { runPipeline, ownershipHost, ownershipValue, nextDelayMs, WORKING } from './domainPipeline.js';
import { clearPublicCache } from './publicCache.js';
import { sendEmail } from './email.js';

const vercelApi = { addDomain: V.addDomain, getProjectDomain: V.getProjectDomain, verifyDomain: V.verifyDomain, getDomainConfig: V.getDomainConfig, removeDomain: V.removeDomain, project: V.vercelProject };

export class DomainError extends Error { constructor(message, status = 400, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }

/** Domains the public site may serve: fully active, or legacy-verified records that predate the Vercel integration. */
export const SERVING = { $or: [{ customDomainStatus: 'active' }, { customDomainStatus: 'verified', 'customDomainMeta.legacy': true }] };

/* ---------- Hostname lookups (cached briefly; cleared on every change) ---------- */
const hostCache = new Map(); // host -> { at, id|null }
const HOST_TTL = 60 * 1000;
export const clearDomainCache = () => { hostCache.clear(); clearPublicCache(); };

/** Active, Pro, non-suspended restaurant that owns this exact hostname, or null. */
export async function restaurantForHost(rawHost) {
  const host = cleanHostInput(rawHost);
  if (!host || isPlatformHost(host)) return null;
  const hit = hostCache.get(host);
  if (hit && Date.now() - hit.at < HOST_TTL) return hit.id;
  const r = await Restaurant.findOne({ customDomain: host, status: 'active', ...SERVING }).select('_id plan').lean();
  const id = r && r.plan === 'pro' ? String(r._id) : null;
  if (hostCache.size > 2000) hostCache.clear();
  hostCache.set(host, { at: Date.now(), id });
  return id;
}

/** CORS: is this browser Origin an https site of a verified, active restaurant? Exact hostname only (no implicit www). */
export async function isAllowedCustomOrigin(origin) {
  let u; try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  return !!(await restaurantForHost(u.hostname));
}

/** Base URL for links we put in emails / Paystack callbacks: the restaurant's own domain when the request really came from it. */
export async function publicBaseFor(req, rest, isPro = true) {
  const fallback = (process.env.CLIENT_URL || '').replace(/\/+$/, '');
  try {
    const o = req.get?.('origin'); if (!o || !rest?.customDomain || !isPro) return fallback;
    const u = new URL(o);
    if (u.protocol === 'https:' && u.hostname === rest.customDomain && (await restaurantForHost(u.hostname)) === String(rest._id)) return `https://${u.hostname}`;
  } catch { /* fall through */ }
  return fallback;
}

/* ---------- View for the dashboard ---------- */
const STAGE_LABEL = {
  none: 'No custom domain', pending_dns: 'Pending DNS configuration', verifying: 'Waiting for verification',
  verified: 'Domain verified, waiting for DNS routing', configuring: 'Configuring SSL', active: 'Active', failed: 'Failed',
};

export function domainView(rest) {
  if (!rest.customDomain) return { domain: null, status: 'none', label: STAGE_LABEL.none };
  const m = rest.customDomainMeta || {};
  const status = rest.customDomainStatus;
  const records = [];
  if (!m.ownershipVerified && !m.legacy) records.push({ id: 'ownership', purpose: 'ownership', type: 'TXT', host: ownershipHost(rest.customDomain), value: ownershipValue(rest.customDomainToken), done: false, title: 'Prove you own this domain' });
  else records.push({ id: 'ownership', purpose: 'ownership', type: 'TXT', host: ownershipHost(rest.customDomain), value: ownershipValue(rest.customDomainToken), done: true, title: 'Prove you own this domain' });
  for (const ch of m.vercelChallenge || []) if (!m.vercelVerified && ch.domain && ch.value) records.push({ id: 'vercel', purpose: 'vercel_verification', type: ch.type || 'TXT', host: ch.domain, value: ch.value, done: false, title: 'Vercel domain verification', note: ch.reason });
  for (const [i, rec] of (m.recommended || []).entries()) records.push({ id: `routing-${i}`, purpose: 'routing', type: rec.type, host: rec.host, value: rec.value, note: rec.note, done: !!m.dnsConfigured, title: 'Point the domain to your ordering page' });

  // Most DNS panels want the host RELATIVE to the registered domain ("order", "@", "_orderly-verify.order"), so give both forms.
  const apex = apexOf(rest.customDomain);
  for (const rec of records) rec.hostLabel = rec.host === apex ? '@' : rec.host.endsWith('.' + apex) ? rec.host.slice(0, -(apex.length + 1)) : rec.host;

  const steps = [
    { key: 'ownership', label: 'Ownership', state: m.ownershipVerified || m.legacy ? 'done' : status === 'failed' ? 'error' : 'waiting' },
    { key: 'verification', label: 'Verification', state: m.vercelVerified ? 'done' : m.ownershipVerified ? (status === 'failed' ? 'error' : 'waiting') : 'todo' },
    { key: 'routing', label: 'DNS routing', state: m.dnsConfigured ? 'done' : m.vercelVerified ? 'waiting' : 'todo' },
    { key: 'ssl', label: 'SSL certificate', state: m.sslReady ? 'done' : m.dnsConfigured ? 'waiting' : 'todo' },
    { key: 'active', label: 'Live', state: status === 'active' ? 'done' : 'todo' },
  ];
  return {
    domain: rest.customDomain, apex, status, label: STAGE_LABEL[status] || status, isApex: rest.customDomain === apex,
    records, steps, issue: m.lastError || null, issueCode: m.lastErrorCode || null,
    lastCheckedAt: m.lastCheckedAt || null, nextCheckAt: ['active', 'failed'].includes(status) ? null : m.nextCheckAt || null,
    activatedAt: m.activatedAt || null, url: status === 'active' ? `https://${rest.customDomain}` : null,
    legacy: !!m.legacy,
    note: 'DNS changes can take from a few minutes up to 48 hours. We check automatically, so you can close this page.',
  };
}

/* ---------- Persistence helpers: every write is conditional on the domain still being the one we worked on ---------- */
async function apply(restId, domain, status, metaPatch, extra = {}) {
  const $set = { customDomainStatus: status }, $unset = {};
  for (const [k, v] of Object.entries(metaPatch || {})) { if (v === undefined) $unset[`customDomainMeta.${k}`] = ''; else $set[`customDomainMeta.${k}`] = v; }
  const upd = { $set: { ...$set, ...extra } };
  if (Object.keys($unset).length) upd.$unset = $unset;
  const res = await Restaurant.findOneAndUpdate({ _id: restId, customDomain: domain }, upd, { new: true });
  clearDomainCache();
  return res;
}

const locks = new Set();

/** Run one check and persist the result. Safe to call from the button and the worker at once (per-restaurant lock). */
export async function checkDomain(restId, { source = 'worker' } = {}) {
  const key = String(restId);
  if (locks.has(key)) return null;
  locks.add(key);
  try {
    const rest = await Restaurant.findById(restId);
    if (!rest?.customDomain || !WORKING.includes(rest.customDomainStatus)) return rest;
    const prev = rest.customDomainStatus;
    const m = rest.customDomainMeta?.toObject ? rest.customDomainMeta.toObject() : { ...(rest.customDomainMeta || {}) };
    const out = await runPipeline({ domain: rest.customDomain, token: rest.customDomainToken, status: prev, meta: m, createdAt: m.createdAt || rest.updatedAt }, { vercel: vercelApi });
    const delay = out.terminal ? null : out.retryAfterMs ?? nextDelayMs(m.createdAt || rest.updatedAt);
    const patch = { ...out.meta, nextCheckAt: delay ? new Date(Date.now() + delay) : undefined };
    if (out.status === 'active') patch.legacy = false;
    const updated = await apply(rest._id, rest.customDomain, out.status, patch);
    if (out.alert) console.error('[custom-domain] Vercel authentication problem: check VERCEL_TOKEN / VERCEL_TEAM_ID');
    if (updated && prev !== out.status && ['active', 'failed'].includes(out.status)) notifyOwner(updated, out.status, out.issue).catch(() => {});
    return updated || rest;
  } finally { locks.delete(key); }
}

async function notifyOwner(rest, status, issue) {
  const u = await User.findById(rest.owner).lean(); if (!u?.email) return;
  const base = (process.env.CLIENT_URL || '').replace(/\/+$/, '');
  sendEmail({
    to: u.email, type: `custom_domain_${status}`, restaurant: rest._id, dedupeKey: `cd:${status}:${rest._id}:${rest.customDomain}`,
    subject: status === 'active' ? `${rest.customDomain} is now live` : `Your domain ${rest.customDomain} could not be connected`,
    body: status === 'active' ? `<p>Your ordering page is now live at <b>https://${rest.customDomain}</b>.</p>` : `<p>${issue || 'The domain could not be verified.'}</p><p>You can connect it again from <a href="${base}/dashboard/settings">Settings</a>.</p>`,
  }).catch(() => {});
}

/* ---------- Register ---------- */
export async function registerDomain(rest, rawDomain) {
  if (!V.vercelConfigured()) throw new DomainError('Custom domains are not available on this server yet. Please contact Ordarly support.', 503);
  const v = validateCustomDomain(rawDomain, { reserved: reservedHosts() });
  if (!v.ok) throw new DomainError(v.error, 400);
  const { domain, isApex, apex } = v;

  if (rest.customDomain === domain && rest.customDomainStatus === 'failed') return retryDomain(rest);
  if (rest.customDomain === domain && ['pending_dns', 'verifying', 'verified', 'configuring', 'active'].includes(rest.customDomainStatus)) return domainView(rest); // idempotent re-submit
  if (rest.customDomain && rest.customDomain !== domain) await disconnectDomain(rest); // replacing: detach the old one first

  // Someone else holds it? A holder whose attempt FAILED (never proved ownership) can be displaced; anyone else cannot.
  const holder = await Restaurant.findOne({ customDomain: domain, _id: { $ne: rest._id } }).select('_id customDomainStatus').lean();
  if (holder) {
    if (holder.customDomainStatus !== 'failed') throw new DomainError('That domain is already connected to another restaurant.', 409);
    const free = await Restaurant.findOneAndUpdate({ _id: holder._id, customDomain: domain, customDomainStatus: 'failed' }, { $unset: { customDomain: '', customDomainToken: '', customDomainMeta: '' }, $set: { customDomainStatus: 'none' } });
    if (!free) throw new DomainError('That domain is already connected to another restaurant.', 409);
  }

  // Atomic claim in MongoDB BEFORE touching Vercel: the unique index guarantees only one restaurant wins a race.
  const token = randomToken(12);
  const now = new Date();
  try {
    const claimed = await Restaurant.findOneAndUpdate(
      { _id: rest._id, $or: [{ customDomain: { $exists: false } }, { customDomain: null }, { customDomain: '' }] },
      { $set: { customDomain: domain, customDomainStatus: 'pending_dns', customDomainToken: token, customDomainMeta: { isApex, ownershipVerified: false, vercelVerified: false, dnsConfigured: false, sslReady: false, createdAt: now, nextCheckAt: new Date(+now + 30000), checkAttempts: 0, legacy: false } } },
      { new: true });
    if (!claimed) throw new DomainError('This restaurant already has a domain. Remove it first.', 409);
  } catch (e) {
    if (e?.code === 11000) throw new DomainError('That domain is already connected to another restaurant.', 409);
    throw e;
  }

  try {
    const pd = await V.addDomain(domain);
    let recommended = [], configuredBy;
    try { const cfg = await V.getDomainConfig(domain); recommended = cfg.records?.length ? cfg.records : routingRecords(domain, cfg); configuredBy = cfg.configuredBy || undefined; } catch { /* the first check will fill these in */ }
    const updated = await apply(rest._id, domain, 'pending_dns', {
      vercelProjectId: pd.projectId || V.vercelProject(), vercelVerified: pd.verified, vercelChallenge: pd.verification, recommended, configuredBy, apexName: apex,
    });
    return domainView(updated || rest);
  } catch (e) {
    // Roll back so a Vercel failure never leaves a half-registered domain blocking this restaurant or the real owner.
    await Restaurant.updateOne({ _id: rest._id, customDomain: domain }, { $unset: { customDomain: '', customDomainToken: '', customDomainMeta: '' }, $set: { customDomainStatus: 'none' } });
    clearDomainCache();
    if (e instanceof V.VercelError) throw new DomainError(e.message, e.status === 409 ? 409 : e.status === 400 ? 400 : e.status === 503 ? 503 : 502);
    throw e;
  }
}

/* ---------- Disconnect ---------- */
export async function disconnectDomain(rest) {
  const domain = rest.customDomain;
  if (!domain) return { ok: true };
  // Ownership of the association is guaranteed by the caller loading the OWNER's restaurant; re-check against the DB anyway.
  const own = await Restaurant.exists({ _id: rest._id, customDomain: domain });
  if (!own) return { ok: true };
  const m = rest.customDomainMeta || {};
  if (m.vercelProjectId || V.vercelConfigured()) {
    try { await V.removeDomain(domain); }
    catch (e) {
      if (e instanceof V.VercelError && e.code === 'not_configured') { if (m.vercelProjectId) throw new DomainError('Could not remove the domain from the hosting provider. Please try again later.', 503); }
      else throw new DomainError('Could not remove the domain from the hosting provider right now. Nothing was changed; please try again in a minute.', 502);
    }
  }
  await Restaurant.updateOne({ _id: rest._id, customDomain: domain }, { $unset: { customDomain: '', customDomainToken: '', customDomainMeta: '' }, $set: { customDomainStatus: 'none' } });
  clearDomainCache();
  return { ok: true };
}

/** Owner pressed "Check connection". Skips the work if a check ran in the last few seconds. */
export async function checkNow(rest) {
  const last = rest.customDomainMeta?.lastCheckedAt;
  if (last && Date.now() - +new Date(last) < 8000) return domainView(rest);
  const updated = await checkDomain(rest._id, { source: 'user' });
  return domainView(updated || (await Restaurant.findById(rest._id)));
}

/** Failed -> try again without retyping: restart the same domain from scratch. */
export async function retryDomain(rest) {
  if (!rest.customDomain) throw new DomainError('No domain set', 400);
  const d = rest.customDomain; await disconnectDomain(rest);
  return registerDomain(await Restaurant.findById(rest._id), d);
}

/* ---------- Background worker ---------- */
let running = false;
export async function runDomainWorker({ batch = 20 } = {}) {
  if (running || !V.vercelConfigured()) return { skipped: true };
  running = true;
  try {
    const now = new Date();
    const due = await Restaurant.find({
      customDomain: { $exists: true, $ne: null }, customDomainStatus: { $in: WORKING },
      $or: [{ 'customDomainMeta.nextCheckAt': { $lte: now } }, { 'customDomainMeta.nextCheckAt': { $exists: false } }],
    }).sort('customDomainMeta.nextCheckAt').limit(batch).select('_id').lean();
    let n = 0;
    for (const { _id } of due) { // sequential on purpose: gentle on Vercel's rate limits
      try { await checkDomain(_id); n++; } catch (e) { console.error('[domains] check failed', String(_id), e.message); }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { checked: n };
  } finally { running = false; }
}

/** Boot-time: mark pre-integration "verified" records as legacy so they keep serving until the worker re-checks them against Vercel. */
export async function migrateLegacyDomains() {
  const r = await Restaurant.updateMany(
    { customDomain: { $exists: true, $ne: null }, customDomainStatus: 'verified', 'customDomainMeta.vercelProjectId': { $exists: false }, 'customDomainMeta.legacy': { $ne: true } },
    { $set: { 'customDomainMeta.legacy': true, 'customDomainMeta.ownershipVerified': true, 'customDomainMeta.createdAt': new Date(), 'customDomainMeta.nextCheckAt': new Date() } });
  if (r.modifiedCount) console.log(`[domains] flagged ${r.modifiedCount} legacy verified domain(s) for re-check`);
  // Legacy pending records have no createdAt; give them one so deadlines are measured from now, not from 1970.
  await Restaurant.updateMany({ customDomain: { $exists: true, $ne: null }, customDomainStatus: 'pending_dns', 'customDomainMeta.createdAt': { $exists: false } }, { $set: { 'customDomainMeta.createdAt': new Date(), 'customDomainMeta.nextCheckAt': new Date() } });
}
