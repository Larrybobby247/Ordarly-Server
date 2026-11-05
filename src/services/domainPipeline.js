// Decision logic for one custom-domain check. NO database access: everything external (DNS, Vercel, TLS) is injected,
// so the same code is used by the dashboard button, the background worker and the unit tests.
//
// Five separate facts are tracked and never conflated:
//   1. ownership      our _orderly-verify TXT record exists with this restaurant's token
//   2. vercelVerified Vercel accepted its own challenge (only needed when the domain is claimed elsewhere on Vercel)
//   3. dnsConfigured  Vercel reports the domain routes to it (config.misconfigured === false)
//   4. sslReady       a real TLS handshake on the domain presents a valid certificate for that hostname
//   5. active         1 AND 2 AND 3 AND 4
import dns from 'dns';
import tls from 'tls';
import { classifyDnsError, flattenTxt, sameTarget, isApexDomain, routingRecords } from './domainUtils.js';

const DAY = 86400000, MIN = 60000;
export const OWNERSHIP_DEADLINE_MS = 7 * DAY;   // TXT ownership never proven -> failed (frees the domain for its real owner)
export const OVERALL_DEADLINE_MS = 14 * DAY;    // ownership proven but routing/SSL never completed -> failed
export const WORKING = ['pending_dns', 'verifying', 'verified', 'configuring'];

export const ownershipHost = (domain) => `_orderly-verify.${domain}`;
export const ownershipValue = (token) => `orderly-verify=${token}`;

/* ---------- Default probes (real network). Tests replace these. ---------- */
const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
try { resolver.setServers((process.env.DNS_RESOLVERS || '1.1.1.1,8.8.8.8').split(',').map((s) => s.trim()).filter(Boolean)); } catch { /* keep system resolvers */ }

export const defaultProbes = {
  async txt(host) { return flattenTxt(await resolver.resolveTxt(host)); },
  async cname(host) { return resolver.resolveCname(host); },
  async a(host) { return resolver.resolve4(host); },
  /** Real TLS handshake with SNI. Only called once Vercel says the domain routes to it. */
  tlsProbe(host) {
    return new Promise((resolve) => {
      const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
      const sock = tls.connect({ host, port: 443, servername: host, timeout: 6000, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () => {
        const cert = sock.getPeerCertificate();
        const nameErr = cert && cert.subject ? tls.checkServerIdentity(host, cert) : new Error('no certificate');
        const valid = sock.authorized && !nameErr;
        done(valid ? { ready: true } : { ready: false, reason: sock.authorized ? 'name_mismatch' : String(sock.authorizationError || 'untrusted') });
      });
      sock.on('timeout', () => done({ ready: false, reason: 'timeout' }));
      sock.on('error', (e) => done({ ready: false, reason: e.code || 'error' }));
    });
  },
};

/* ---------- Small DNS wrappers returning a classified result ---------- */
async function lookup(fn) {
  try { return { state: 'ok', values: await fn() }; }
  catch (e) { return { state: classifyDnsError(e), code: e.code, values: [] }; }
}

export async function checkOwnershipTxt(domain, token, probes) {
  const r = await lookup(() => probes.txt(ownershipHost(domain)));
  if (r.state === 'temporary') return { state: 'temporary' };
  if (r.state === 'missing' || !r.values.length) return { state: 'missing' };
  if (r.values.some((v) => v.trim() === ownershipValue(token))) return { state: 'ok' };
  return { state: 'mismatch', found: r.values.filter((v) => v.startsWith('orderly-verify=')).slice(0, 3) };
}

async function checkVercelChallenge(ch, probes) {
  const r = await lookup(() => probes.txt(ch.domain));
  if (r.state === 'temporary') return 'temporary';
  if (r.state === 'missing' || !r.values.length) return 'missing';
  return r.values.some((v) => v.trim() === ch.value) ? 'ok' : 'mismatch';
}

/** Explain WHY routing is not right yet, in plain words. Vercel's `misconfigured` flag stays the authority. */
export async function explainRouting(domain, config, probes) {
  const wantCname = (config.recommendedCNAME || []).map((c) => c.value);
  const wantIps = (config.recommendedIPv4 || []).flatMap((c) => (Array.isArray(c.value) ? c.value : [c.value]));
  const apex = isApexDomain(domain);
  const cn = await lookup(() => probes.cname(domain));
  if (cn.state === 'temporary') return { code: 'dns_temporary', message: 'Your DNS provider did not answer just now. We will check again shortly.' };
  if (cn.values.length) {
    if (cn.values.some((v) => wantCname.some((w) => sameTarget(v, w)))) return { code: 'propagating', message: 'The CNAME record is correct. Waiting for Vercel to detect it.' };
    return { code: 'cname_wrong', message: `The CNAME for ${domain} points to ${cn.values[0]}, but it must point to ${wantCname[0] || 'the target shown above'}. Edit that record.` };
  }
  const a = await lookup(() => probes.a(domain));
  if (a.state === 'temporary') return { code: 'dns_temporary', message: 'Your DNS provider did not answer just now. We will check again shortly.' };
  if (a.values.length) {
    if (a.values.some((v) => wantIps.includes(v))) return { code: 'propagating', message: 'The A record is correct. Waiting for Vercel to detect it.' };
    return { code: 'a_wrong', message: `${domain} currently points to ${a.values.join(', ')}. ${apex ? `Change the A record to ${wantIps[0] || 'the value shown above'}.` : 'Replace it with the CNAME record shown above (delete the old A record first).'}` };
  }
  return { code: 'routing_missing', message: apex ? `No A record found for ${domain} yet. Add the record shown above; DNS can take a few minutes to a few hours to update.` : `No CNAME record found for ${domain} yet. Add the record shown above; DNS can take a few minutes to a few hours to update.` };
}

/** How long to wait before the next automatic check, growing as the domain gets older. */
export function nextDelayMs(createdAt, now = Date.now()) {
  const age = now - +new Date(createdAt || now);
  if (age < 10 * MIN) return 30 * 1000;
  if (age < 60 * MIN) return 2 * MIN;
  if (age < 6 * 60 * MIN) return 10 * MIN;
  if (age < 2 * DAY) return 30 * MIN;
  return 2 * 60 * MIN;
}

/**
 * Run every stage that can progress and return what changed.
 *   input:  { domain, token, status, meta, createdAt }          (plain values)
 *   deps:   { vercel, probes, now }                              (injected)
 *   output: { status, meta (patch), issue, retryAfterMs, terminal }
 * Never throws for expected conditions; Vercel outages / rate limits become `issue` + a retry time.
 */
export async function runPipeline(input, deps) {
  const { vercel, probes = defaultProbes } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const { domain, token } = input;
  const meta = { ...(input.meta || {}) };
  const patch = {};
  const set = (k, v) => { patch[k] = v; meta[k] = v; };
  let issue = null, issueCode = null, retryAfterMs = null;
  const age = now - +new Date(input.createdAt || now);
  const fail = (message, code) => ({ status: 'failed', meta: { ...patch, lastError: message, lastErrorCode: code }, issue: message, terminal: true });

  set('lastCheckedAt', new Date(now));
  set('checkAttempts', (meta.checkAttempts || 0) + 1);

  try {
    /* 0. Make sure the domain is registered with OUR Vercel project (also adopts legacy records). */
    if (!meta.vercelProjectId) {
      const d = await vercel.addDomain(domain);
      set('vercelProjectId', d.projectId || vercel.project());
      set('vercelVerified', !!d.verified);
      set('vercelChallenge', d.verification || []);
    }

    /* 1. Ownership: our TXT record. Legacy records were already verified this way. Once proven it stays proven. */
    if (!meta.ownershipVerified && meta.legacy) { set('ownershipVerified', true); set('ownershipVerifiedAt', new Date(now)); }
    if (!meta.ownershipVerified) {
      const o = await checkOwnershipTxt(domain, token, probes);
      if (o.state === 'ok') { set('ownershipVerified', true); set('ownershipVerifiedAt', new Date(now)); }
      else {
        issueCode = `ownership_${o.state}`;
        issue = o.state === 'missing' ? `We cannot see the ownership TXT record yet (${ownershipHost(domain)}). Add it at your domain provider; it can take a few minutes to a few hours to appear.`
          : o.state === 'mismatch' ? `A TXT record exists at ${ownershipHost(domain)} but its value is wrong${o.found?.length ? ` (found ${o.found[0]})` : ''}. Replace it with the exact value shown above.`
            : 'Your DNS provider did not answer just now. We will check again shortly.';
        if (age > OWNERSHIP_DEADLINE_MS) return fail('We could not find the ownership TXT record within 7 days, so this domain was disconnected. Connect it again and add the records.', 'ownership_timeout');
        return { status: 'pending_dns', meta: { ...patch, lastError: issue, lastErrorCode: issueCode }, issue, terminal: false };
      }
    }

    /* 2. Vercel's own verification (required only if Vercel reports verified=false). */
    if (!meta.vercelVerified) {
      const pd = await vercel.getProjectDomain(domain);
      if (!pd) { set('vercelProjectId', undefined); throw Object.assign(new Error('Domain is missing from the Vercel project'), { code: 'vercel_missing', transient: true }); }
      set('vercelChallenge', pd.verification || []);
      if (pd.verified) set('vercelVerified', true);
      else {
        const ch = (pd.verification || []).find((c) => c.type === 'TXT') || pd.verification?.[0];
        const st = ch ? await checkVercelChallenge(ch, probes) : 'missing';
        if (st === 'ok' || !ch) {
          const v = await vercel.verifyDomain(domain);
          if (v.verified) set('vercelVerified', true);
          else if (v.reason === 'conflict') return fail(`${domain} is verified for another Vercel project, so it cannot be used here. Remove it from that project, then connect it again.`, 'vercel_conflict');
          else { issueCode = `vercel_${v.reason}`; issue = 'Vercel has not accepted the verification record yet. It is retried automatically.'; }
        } else {
          issueCode = `vercel_challenge_${st}`;
          issue = st === 'mismatch' ? `The Vercel verification TXT record at ${ch.domain} has the wrong value. Replace it with the value shown above.`
            : st === 'temporary' ? 'Your DNS provider did not answer just now. We will check again shortly.'
              : `We cannot see the Vercel verification TXT record yet (${ch.domain}). Add it at your domain provider.`;
        }
        if (!meta.vercelVerified) {
          if (age > OVERALL_DEADLINE_MS) return fail('Domain verification did not finish within 14 days, so it was stopped. Connect it again to restart.', 'verify_timeout');
          return { status: 'verifying', meta: { ...patch, lastError: issue, lastErrorCode: issueCode }, issue, terminal: false };
        }
      }
    }

    /* 3. Routing: ask Vercel how the domain is configured. */
    const cfg = await vercel.getDomainConfig(domain);
    set('recommended', cfg.records?.length ? cfg.records : routingRecords(domain, cfg));
    set('configuredBy', cfg.configuredBy || undefined);
    set('dnsConfigured', !cfg.misconfigured);
    if (cfg.misconfigured) {
      const ex = await explainRouting(domain, cfg, probes);
      issue = ex.message; issueCode = ex.code;
      if (age > OVERALL_DEADLINE_MS) return fail('The DNS routing records were not detected within 14 days, so this domain was stopped. Connect it again to restart.', 'routing_timeout');
      set('sslReady', false);
      return { status: 'verified', meta: { ...patch, lastError: issue, lastErrorCode: issueCode }, issue, terminal: false };
    }

    /* 4. SSL: a real handshake must present a valid certificate for the hostname. */
    const t = await probes.tlsProbe(domain);
    set('sslReady', !!t.ready);
    if (!t.ready) {
      issueCode = 'ssl_pending'; issue = 'DNS is correct. Vercel is issuing the SSL certificate, which usually takes a minute or two.';
      if (age > OVERALL_DEADLINE_MS) return fail('The SSL certificate was not issued within 14 days, so this domain was stopped. Connect it again to restart.', 'ssl_timeout');
      return { status: 'configuring', meta: { ...patch, lastError: undefined, lastErrorCode: issueCode }, issue, terminal: false, info: true };
    }

    /* 5. Everything is true. */
    set('activatedAt', meta.activatedAt || new Date(now));
    return { status: 'active', meta: { ...patch, lastError: undefined, lastErrorCode: undefined }, issue: null, terminal: true };
  } catch (e) {
    const transient = e.transient || e.status === 429 || e.code === 'vercel_missing';
    if (e.code === 'not_configured') return { status: input.status, meta: { ...patch, lastError: e.message, lastErrorCode: 'not_configured' }, issue: e.message, retryAfterMs: 10 * MIN, terminal: false };
    if (e.status === 409) return fail(e.message, e.code || 'vercel_conflict');
    retryAfterMs = e.retryAfterMs || (transient ? 2 * MIN : null);
    const msg = transient ? 'We could not reach Vercel just now. This is retried automatically.' : e.message || 'Unexpected error while checking the domain.';
    if (!transient && (e.status === 401 || e.status === 403)) return { status: input.status, meta: { ...patch, lastError: 'Ordarly could not authenticate with Vercel. Support has been notified.', lastErrorCode: 'vercel_auth' }, issue: 'Ordarly could not authenticate with Vercel.', retryAfterMs: 15 * MIN, terminal: false, alert: true };
    return { status: input.status, meta: { ...patch, lastError: msg, lastErrorCode: e.code || 'check_error' }, issue: msg, retryAfterMs, terminal: false };
  }
}
