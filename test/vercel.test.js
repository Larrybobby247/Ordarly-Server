// The Vercel client against a stubbed fetch: checks the exact endpoints, team handling and error mapping. (A live test needs a real token.)
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.VERCEL_TOKEN = 'tok_secret'; process.env.VERCEL_PROJECT_ID = 'prj_abc';
const V = await import('../src/services/vercel.js');

const realFetch = globalThis.fetch;
let calls = [];
const reply = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });
const stub = (...responses) => { calls = []; let i = 0; globalThis.fetch = async (url, init) => { calls.push({ url, init }); return responses[Math.min(i++, responses.length - 1)]; }; };
test.afterEach(() => { globalThis.fetch = realFetch; delete process.env.VERCEL_TEAM_ID; });

test('addDomain: POST /v10 endpoint, bearer token, personal account has no teamId', async () => {
  stub(reply(200, { name: 'a.com', apexName: 'a.com', projectId: 'prj_abc', verified: true, verification: [] }));
  const r = await V.addDomain('a.com');
  assert.equal(calls[0].url, 'https://api.vercel.com/v10/projects/prj_abc/domains'); assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok_secret'); assert.deepEqual(JSON.parse(calls[0].init.body), { name: 'a.com' });
  assert.equal(r.verified, true); assert.equal(r.alreadyOnProject, false);
});
test('team account: teamId is added to every call', async () => {
  process.env.VERCEL_TEAM_ID = 'team_123';
  stub(reply(200, { name: 'a.com', projectId: 'prj_abc', verified: true }));
  await V.addDomain('a.com'); assert.match(calls[0].url, /\/domains\?teamId=team_123$/);
  stub(reply(200, { misconfigured: false, configuredBy: 'CNAME', recommendedCNAME: [], recommendedIPv4: [] }));
  await V.getDomainConfig('a.com'); assert.match(calls[0].url, /\/v6\/domains\/a\.com\/config\?teamId=team_123&projectIdOrName=prj_abc$/);
});
test('addDomain: "already on this project" (400) is adopted by reading the existing record', async () => {
  stub(reply(400, { error: { code: 'bad_request', message: 'Domain a.com already exists on this project' } }), reply(200, { name: 'a.com', projectId: 'prj_abc', verified: true, verification: [] }));
  const r = await V.addDomain('a.com'); assert.equal(r.alreadyOnProject, true); assert.equal(calls[1].init.method, 'GET'); assert.match(calls[1].url, /\/v9\/projects\/prj_abc\/domains\/a\.com$/);
});
test('addDomain: domain owned by another project/account gives an actionable 409', async () => {
  stub(reply(409, { error: { code: 'domain_already_in_use', message: 'The domain is already assigned to another Vercel project' } }));
  await assert.rejects(() => V.addDomain('a.com'), (e) => e.status === 409 && /another Vercel project or account/.test(e.message) && /remove it/i.test(e.message));
});
test('verifyDomain: "TXT not found" (400) is a normal not-yet, not an exception', async () => {
  stub(reply(400, { error: { code: 'missing_txt_record', message: 'The domain does not have a TXT record that attempts to verify the project domain' } }));
  const r = await V.verifyDomain('a.com'); assert.deepEqual([r.verified, r.reason], [false, 'missing']); assert.match(calls[0].url, /\/v9\/projects\/prj_abc\/domains\/a\.com\/verify$/);
});
test('verifyDomain: TXT verifying another project is reported as a conflict', async () => {
  stub(reply(400, { error: { message: 'There is an existing TXT record on the domain verifying it for another project' } }));
  assert.equal((await V.verifyDomain('a.com')).reason, 'conflict');
});
test('getProjectDomain: 404 means not on our project', async () => { stub(reply(404, { error: { code: 'not_found', message: 'nope' } })); assert.equal(await V.getProjectDomain('a.com'), null); });
test('removeDomain: DELETE on OUR project; already-gone counts as removed', async () => {
  stub(reply(200, {})); assert.equal((await V.removeDomain('a.com')).removed, true); assert.equal(calls[0].init.method, 'DELETE'); assert.match(calls[0].url, /\/v9\/projects\/prj_abc\/domains\/a\.com$/);
  stub(reply(404, { error: { message: 'gone' } })); assert.equal((await V.removeDomain('a.com')).absent, true);
});
test('rate limit surfaces as a transient error with a retry time', async () => {
  stub(reply(429, { error: { message: 'slow down' } }, { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120) }));
  await assert.rejects(() => V.getDomainConfig('a.com'), (e) => e.code === 'rate_limited' && e.transient && e.retryAfterMs > 60000);
});
test('server errors are retried then reported as transient; missing credentials fail clearly without any request', async () => {
  stub(reply(503, { error: { message: 'down' } })); await assert.rejects(() => V.getProjectDomain('a.com'), (e) => e.transient && calls.length === 3);
  const t = process.env.VERCEL_TOKEN; delete process.env.VERCEL_TOKEN; stub(reply(200, {}));
  await assert.rejects(() => V.addDomain('a.com'), (e) => e.code === 'not_configured' && calls.length === 0); process.env.VERCEL_TOKEN = t;
});
test('domain names are URL-encoded in the path', async () => { stub(reply(200, {})); await V.removeDomain('a.com/../../x'); assert.ok(!calls[0].url.includes('/../')); });
