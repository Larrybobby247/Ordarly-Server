// Thin, reusable client for the Vercel REST API (domains on ONE project). Secrets come from the environment and never leave the server.
//   VERCEL_TOKEN        access token with access to the project's team/account
//   VERCEL_PROJECT_ID   id (prj_...) or name of the Ordarly FRONTEND project that serves every restaurant
//   VERCEL_TEAM_ID      optional: set when the project belongs to a team (team_...). Leave unset for a personal account.
// Endpoints used (https://vercel.com/docs/rest-api):
//   POST   /v10/projects/{project}/domains                add a domain to the project
//   GET    /v9/projects/{project}/domains/{domain}        project-domain state + verification challenge
//   POST   /v9/projects/{project}/domains/{domain}/verify ask Vercel to check its challenge
//   DELETE /v9/projects/{project}/domains/{domain}        remove from the project
//   GET    /v6/domains/{domain}/config                    DNS routing state + recommended records
import { routingRecords } from './domainUtils.js';

const API = 'https://api.vercel.com';

export class VercelError extends Error {
  constructor(message, { status = 502, code = 'vercel_error', retryAfterMs, transient = false } = {}) {
    super(message); this.name = 'VercelError'; this.status = status; this.code = code; this.retryAfterMs = retryAfterMs; this.transient = transient;
  }
}

export const vercelConfigured = () => !!(process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID);
export const vercelProject = () => process.env.VERCEL_PROJECT_ID;

function requireConfigured() {
  if (!vercelConfigured()) throw new VercelError('Custom domains are not set up on this server yet (VERCEL_TOKEN / VERCEL_PROJECT_ID missing). Please contact Ordarly support.', { status: 503, code: 'not_configured' });
}

const teamQuery = () => (process.env.VERCEL_TEAM_ID ? `teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : '');
const withTeam = (path, extra = '') => {
  const q = [teamQuery(), extra].filter(Boolean).join('&');
  return q ? `${path}${path.includes('?') ? '&' : '?'}${q}` : path;
};

async function call(method, path, body, { retries = 2 } = {}) {
  requireConfigured();
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      if (attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
      throw new VercelError(e.name === 'TimeoutError' ? 'Vercel took too long to respond. Please try again.' : 'Could not reach Vercel. Please try again.', { status: 504, code: 'unreachable', transient: true });
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    const err = data?.error || {};
    const code = err.code || `http_${res.status}`;
    if (res.status === 429) { // rate limited: honour Vercel's reset header, retry once briefly, otherwise surface so the worker backs off
      const reset = Number(res.headers.get('x-ratelimit-reset')); const waitMs = Number.isFinite(reset) && reset > 0 ? Math.max(1000, reset * 1000 - Date.now()) : 15000;
      if (attempt < 1 && waitMs <= 5000) { await sleep(waitMs); continue; }
      throw new VercelError('Vercel is rate limiting requests. We will retry automatically.', { status: 429, code: 'rate_limited', retryAfterMs: waitMs, transient: true });
    }
    if (res.status >= 500 && attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
    throw new VercelError(err.message || `Vercel error (${res.status})`, { status: res.status, code, transient: res.status >= 500 });
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const projectPath = () => `/projects/${encodeURIComponent(vercelProject())}`;
const enc = encodeURIComponent;

/** Normalised view of a project-domain response. */
const shapeProjectDomain = (d) => ({
  name: d.name, apexName: d.apexName, projectId: d.projectId, verified: !!d.verified,
  verification: (d.verification || []).map(({ type, domain, value, reason }) => ({ type, domain, value, reason })),
  redirect: d.redirect || null,
});

/** 1. Register the domain with the Ordarly project. Idempotent: if it is already on OUR project we just read it back. */
export async function addDomain(domain) {
  try {
    return { ...shapeProjectDomain(await call('POST', withTeam(`/v10${projectPath()}/domains`), { name: domain })), alreadyOnProject: false };
  } catch (e) {
    if (e instanceof VercelError && e.status === 400) {
      // Vercel answers 400 when the domain is already on this project. Rather than trust the wording of the message,
      // look the domain up: if it really is on OUR project we adopt it, otherwise the 400 is a genuine validation error.
      const existing = await getProjectDomain(domain).catch(() => null);
      if (existing) return { ...existing, alreadyOnProject: true };
      throw new VercelError(friendly400(e.message, domain), { status: 400, code: e.code });
    }
    if (e instanceof VercelError && e.status === 409) throw explainConflict(e, domain);
    throw e;
  }
}

function explainConflict(e, domain) {
  const m = e.message || '';
  let text;
  if (/another (vercel )?project|assigned to a project on this account|already.*on their account|owner already has/i.test(m)) {
    text = `${domain} is already connected to another Vercel project or account. If you own it, remove it from that project (or the other service that serves it) first, then try again. If you cannot, contact Ordarly support.`;
  } else if (/not allowed/i.test(m)) text = `${domain} cannot be used on this platform. Please choose a different domain.`;
  else if (/transferred/i.test(m)) text = 'The hosting project is being updated right now. Please try again in a few minutes.';
  else text = `${domain} is already in use on another hosting account. Remove it from there first, then try again.`;
  return new VercelError(text, { status: 409, code: e.code || 'domain_conflict' });
}
const friendly400 = (m, domain) => (/not valid|invalid/i.test(m) ? `Vercel rejected "${domain}" as an invalid domain.` : /production deployment/i.test(m) ? 'The site cannot accept new domains until its latest production deployment succeeds. Please contact Ordarly support.' : m);

/** 2/3. Project-domain state: does it belong to our project, is it verified, what challenge is pending. Returns null when it is not on our project. */
export async function getProjectDomain(domain) {
  try { return shapeProjectDomain(await call('GET', withTeam(`/v9${projectPath()}/domains/${enc(domain)}`))); }
  catch (e) { if (e instanceof VercelError && e.status === 404) return null; throw e; }
}

/** 4. Ask Vercel to check its ownership challenge. Returns { verified, reason }. A 400 here is a normal "not yet", not an outage. */
export async function verifyDomain(domain) {
  try {
    const d = await call('POST', withTeam(`/v9${projectPath()}/domains/${enc(domain)}/verify`), undefined, { retries: 1 });
    return { verified: !!d.verified, reason: null, domain: shapeProjectDomain(d) };
  } catch (e) {
    if (e instanceof VercelError && e.status === 400) {
      const reason = /another project/i.test(e.message) ? 'conflict' : /does not have a TXT/i.test(e.message) ? 'missing' : /does not match/i.test(e.message) ? 'mismatch' : 'pending';
      return { verified: false, reason, message: e.message };
    }
    throw e;
  }
}

/** 5/6. DNS routing state as Vercel sees it. `misconfigured: false` means routed AND a TLS certificate can be issued. */
export async function getDomainConfig(domain) {
  const c = await call('GET', withTeam(`/v6/domains/${enc(domain)}/config`, `projectIdOrName=${enc(vercelProject())}`));
  return {
    configuredBy: c.configuredBy ?? null, misconfigured: !!c.misconfigured, acceptedChallenges: c.acceptedChallenges || [],
    recommendedCNAME: c.recommendedCNAME || [], recommendedIPv4: c.recommendedIPv4 || [],
    records: routingRecords(domain, c),
  };
}

/** 7. Detach the domain from OUR project only. A domain that is not on the project counts as already removed. */
export async function removeDomain(domain) {
  try { await call('DELETE', withTeam(`/v9${projectPath()}/domains/${enc(domain)}`)); return { removed: true }; }
  catch (e) { if (e instanceof VercelError && e.status === 404) return { removed: false, absent: true }; throw e; }
}
