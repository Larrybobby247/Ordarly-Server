// Run with: npm test   (Node's built-in test runner; no extra packages, no database, no network)
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCustomDomain, apexOf, isApexDomain, routingRecords, cleanHostInput, flattenTxt } from '../src/services/domainUtils.js';
import { runPipeline, ownershipHost, ownershipValue, nextDelayMs } from '../src/services/domainPipeline.js';
import { yearlyQuote } from '../src/config/plans.js';

/* ---------------- validation ---------------- */
test('accepts apex and subdomains, normalises input', () => {
  assert.deepEqual(validateCustomDomain('restaurant.com'), { ok: true, domain: 'restaurant.com', apex: 'restaurant.com', isApex: true });
  const w = validateCustomDomain('https://WWW.Restaurant.com/menu?x=1'); assert.equal(w.domain, 'www.restaurant.com'); assert.equal(w.isApex, false);
  const ng = validateCustomDomain('order.foodhub.com.ng'); assert.equal(ng.apex, 'foodhub.com.ng'); assert.equal(ng.isApex, false);
  assert.equal(validateCustomDomain('foodhub.com.ng').isApex, true);
});
test('rejects invalid, localhost, IPs, hosting domains and reserved hosts', () => {
  for (const bad of ['', 'localhost', 'foo.localhost', '127.0.0.1', '10.0.0.5', '[::1]', 'nodots', '-bad.com', 'bad-.com', 'a..com', 'exa mple.com', 'foo.vercel.app', 'x.onrender.com', 'foo.invalid', 'under_score.com', 'münchen.de'])
    assert.equal(validateCustomDomain(bad).ok, false, bad);
  assert.equal(validateCustomDomain('ordarly.com.ng', { reserved: ['ordarly.com.ng'] }).ok, false);
  assert.equal(validateCustomDomain('shop.ordarly.com.ng', { reserved: ['ordarly.com.ng'] }).ok, false);
  assert.equal(validateCustomDomain('a'.repeat(64) + '.com').ok, false);
});
test('apex detection handles two-part suffixes', () => {
  assert.equal(apexOf('a.b.foodhub.com.ng'), 'foodhub.com.ng'); assert.equal(isApexDomain('foodhub.com'), true); assert.equal(isApexDomain('www.foodhub.com'), false);
});
test('cleanHostInput strips scheme, port, credentials, path and trailing dot', () => {
  assert.equal(cleanHostInput('HTTPS://user:pw@Shop.Example.com:8443/a/b?c#d'), 'shop.example.com'); assert.equal(cleanHostInput('shop.example.com.'), 'shop.example.com');
});
test('TXT chunks are joined', () => assert.deepEqual(flattenTxt([['orderly-', 'verify=abc'], ['x']]), ['orderly-verify=abc', 'x']));

/* ---------------- DNS records come from Vercel's answer, apex vs subdomain differ ---------------- */
const CFG = { recommendedCNAME: [{ rank: 2, value: 'old.vercel-dns.com' }, { rank: 1, value: 'abc123.vercel-dns-017.com' }], recommendedIPv4: [{ rank: 1, value: ['76.76.21.21'] }] };
test('subdomain gets a CNAME using the rank-1 value from Vercel', () => {
  const r = routingRecords('order.restaurant.com', CFG); assert.equal(r.length, 1); assert.equal(r[0].type, 'CNAME'); assert.equal(r[0].value, 'abc123.vercel-dns-017.com'); assert.equal(r[0].hostLabel, 'order');
});
test('apex gets an A record from Vercel (never a CNAME)', () => {
  const r = routingRecords('restaurant.com', CFG); assert.equal(r[0].type, 'A'); assert.equal(r[0].value, '76.76.21.21'); assert.equal(r[0].hostLabel, '@');
});
test('no hardcoded values: empty Vercel answer gives no routing records', () => assert.deepEqual(routingRecords('restaurant.com', {}), []));

/* ---------------- pipeline with fake Vercel / DNS / TLS ---------------- */
const D = 'order.restaurant.com', TOKEN = 'tok123';
const baseInput = (over = {}) => ({ domain: D, token: TOKEN, status: 'pending_dns', createdAt: new Date(), meta: {}, ...over });
function fakes({ txt = {}, cname = {}, a = {}, vercel = {}, tlsReady = true } = {}) {
  const dnsErr = (code) => Object.assign(new Error(code), { code });
  const answer = (table) => async (host) => { const v = table[host]; if (v instanceof Error) throw v; if (!v) throw dnsErr('ENODATA'); return v; };
  const calls = { verify: 0, config: 0, tls: 0, add: 0 };
  return {
    calls,
    deps: {
      probes: { txt: answer(txt), cname: answer(cname), a: answer(a), tlsProbe: async () => { calls.tls++; return tlsReady ? { ready: true } : { ready: false, reason: 'timeout' }; } },
      vercel: {
        project: () => 'prj_1',
        addDomain: async () => { calls.add++; return { projectId: 'prj_1', verified: true, verification: [], ...(vercel.add || {}) }; },
        getProjectDomain: async () => vercel.projectDomain ?? { verified: true, verification: [] },
        verifyDomain: async () => { calls.verify++; return vercel.verifyResult ?? { verified: true }; },
        getDomainConfig: async () => { calls.config++; if (vercel.configError) throw vercel.configError; return { configuredBy: vercel.configuredBy ?? 'CNAME', misconfigured: vercel.misconfigured ?? false, recommendedCNAME: CFG.recommendedCNAME, recommendedIPv4: CFG.recommendedIPv4, records: routingRecords(D, CFG) }; },
      },
    },
  };
}
const OWN = { [ownershipHost(D)]: [ownershipValue(TOKEN)] };

test('missing TXT keeps the domain pending and does NOT call Vercel verification/config', async () => {
  const f = fakes(); const out = await runPipeline(baseInput(), f.deps);
  assert.equal(out.status, 'pending_dns'); assert.match(out.issue, /cannot see the ownership TXT/); assert.equal(f.calls.config, 0);
});
test('wrong TXT value is reported as wrong, not missing', async () => {
  const f = fakes({ txt: { [ownershipHost(D)]: ['orderly-verify=nope'] } }); const out = await runPipeline(baseInput(), f.deps);
  assert.equal(out.status, 'pending_dns'); assert.match(out.issue, /value is wrong/); assert.match(out.issue, /orderly-verify=nope/);
});
test('temporary DNS failure is not treated as "missing"', async () => {
  const f = fakes({ txt: { [ownershipHost(D)]: Object.assign(new Error('t'), { code: 'ETIMEOUT' }) } }); const out = await runPipeline(baseInput(), f.deps);
  assert.equal(out.status, 'pending_dns'); assert.match(out.issue, /did not answer/); assert.equal(out.terminal, false);
});
test('TXT alone never activates: wrong CNAME keeps it at verified with an explanation', async () => {
  const f = fakes({ txt: OWN, cname: { [D]: ['somewhere-else.example.net'] }, vercel: { misconfigured: true } });
  const out = await runPipeline(baseInput(), f.deps);
  assert.equal(out.status, 'verified'); assert.equal(out.meta.ownershipVerified, true); assert.equal(out.meta.dnsConfigured, false);
  assert.match(out.issue, /points to somewhere-else\.example\.net/); assert.equal(f.calls.tls, 0);
});
test('missing CNAME and A are explained', async () => {
  const out = await runPipeline(baseInput(), fakes({ txt: OWN, vercel: { misconfigured: true } }).deps); assert.match(out.issue, /No CNAME record found/);
});
test('apex with a wrong A record tells the owner what to change it to', async () => {
  const apex = 'restaurant.com'; const f = fakes({ txt: { [ownershipHost(apex)]: [ownershipValue(TOKEN)] }, a: { [apex]: ['1.2.3.4'] }, vercel: { misconfigured: true } });
  const cfgOut = await runPipeline(baseInput({ domain: apex }), f.deps); assert.match(cfgOut.issue, /currently points to 1\.2\.3\.4/); assert.match(cfgOut.issue, /76\.76\.21\.21/);
});
test('correct routing but no certificate yet -> configuring (SSL pending), not active', async () => {
  const out = await runPipeline(baseInput(), fakes({ txt: OWN, tlsReady: false }).deps);
  assert.equal(out.status, 'configuring'); assert.equal(out.meta.dnsConfigured, true); assert.equal(out.meta.sslReady, false);
});
test('ownership + Vercel verified + routing + TLS => active', async () => {
  const out = await runPipeline(baseInput(), fakes({ txt: OWN }).deps);
  assert.equal(out.status, 'active'); assert.equal(out.terminal, true); assert.ok(out.meta.activatedAt); assert.equal(out.meta.sslReady, true);
});
test('Vercel challenge: TXT present -> verify call -> proceeds; TXT absent -> stays verifying without calling verify', async () => {
  const challenge = { type: 'TXT', domain: '_vercel.restaurant.com', value: 'vc-domain-verify=order.restaurant.com,abc', reason: 'pending_domain_verification' };
  const notVerified = { add: { verified: false, verification: [challenge] }, projectDomain: { verified: false, verification: [challenge] } };
  const f1 = fakes({ txt: OWN, vercel: notVerified }); const o1 = await runPipeline(baseInput(), f1.deps);
  assert.equal(o1.status, 'verifying'); assert.equal(f1.calls.verify, 0); assert.match(o1.issue, /_vercel\.restaurant\.com/);
  const f2 = fakes({ txt: { ...OWN, '_vercel.restaurant.com': [challenge.value] }, vercel: notVerified }); const o2 = await runPipeline(baseInput(), f2.deps);
  assert.equal(f2.calls.verify, 1); assert.equal(o2.status, 'active');
});
test('domain verified for another Vercel project fails permanently with an actionable message', async () => {
  const challenge = { type: 'TXT', domain: '_vercel.restaurant.com', value: 'v', reason: 'x' };
  const f = fakes({ txt: { ...OWN, '_vercel.restaurant.com': ['v'] }, vercel: { add: { verified: false, verification: [challenge] }, projectDomain: { verified: false, verification: [challenge] }, verifyResult: { verified: false, reason: 'conflict' } } });
  const out = await runPipeline(baseInput(), f.deps); assert.equal(out.status, 'failed'); assert.equal(out.terminal, true); assert.match(out.issue, /another Vercel project/);
});
test('Vercel outage or rate limit is retried, never fails the domain or corrupts state', async () => {
  const rl = Object.assign(new Error('rate'), { status: 429, code: 'rate_limited', retryAfterMs: 90000, transient: true });
  const out = await runPipeline(baseInput({ status: 'verified', meta: { vercelProjectId: 'prj_1', vercelVerified: true, ownershipVerified: true } }), fakes({ txt: OWN, vercel: { configError: rl } }).deps);
  assert.equal(out.status, 'verified'); assert.equal(out.terminal, false); assert.equal(out.retryAfterMs, 90000);
});
test('ownership never proven after 7 days => failed (frees the domain)', async () => {
  const out = await runPipeline(baseInput({ createdAt: new Date(Date.now() - 8 * 86400000) }), fakes().deps); assert.equal(out.status, 'failed'); assert.equal(out.meta.lastErrorCode, 'ownership_timeout');
});
test('legacy verified domains are adopted into Vercel and activated without needing the TXT again', async () => {
  const f = fakes({}); const out = await runPipeline(baseInput({ status: 'verified', meta: { legacy: true } }), f.deps);
  assert.equal(f.calls.add, 1); assert.equal(out.status, 'active'); assert.equal(out.meta.ownershipVerified, true);
});
test('ownership, once proven, is not re-checked (TXT can be removed later)', async () => {
  const out = await runPipeline(baseInput({ status: 'verified', meta: { vercelProjectId: 'prj_1', vercelVerified: true, ownershipVerified: true } }), fakes().deps); assert.equal(out.status, 'active');
});
test('retry interval grows with age', () => {
  const now = Date.now(); assert.ok(nextDelayMs(now - 60000, now) < nextDelayMs(now - 3 * 3600000, now)); assert.ok(nextDelayMs(now - 5 * 86400000, now) >= 3600000);
});

/* ---------------- yearly plan ---------------- */
test('yearly price is 12 months minus 5%, computed from the live monthly price', () => {
  const q = yearlyQuote({ pro: { priceNgn: 7500 } }); assert.equal(q.price, 85500); assert.equal(q.savings, 4500); assert.equal(q.periodDays, 365);
  assert.equal(yearlyQuote({ pro: { priceNgn: 10000, yearlyDiscountPct: 10 } }).price, 108000);
});
