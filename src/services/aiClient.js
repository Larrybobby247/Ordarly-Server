// AI provider client (Groq today; the interface is provider-neutral so another provider can be added without touching the conversation engine).
//
// The rule this file exists to keep: AI is an OPTIONAL helper. Nothing here ever throws to the caller, and every failure becomes
// { ok:false, kind } so the conversation engine can carry on with the deterministic reader. A circuit breaker stops us hammering a
// provider that is rate-limited, out of quota, mis-configured or down, and closes again by itself.
//
// Dependencies are injected (fetch, clock, random, and a `store` for breaker state and usage), so it is unit-tested with no network or database.

export const FAIL = Object.freeze({ RATE: 'rate_limited', QUOTA: 'quota', TIMEOUT: 'timeout', NETWORK: 'network', AUTH: 'auth', MODEL: 'model', MALFORMED: 'malformed', ERROR: 'error', OFF: 'off', LIMIT: 'limit', OPEN: 'open' });

/** HTTP/transport problem -> { kind, openMs, permanent }. openMs = how long to stop calling the provider. */
export function classifyAiError({ status, body, network, timeout, retryAfterSec }, now = new Date(), rnd = Math.random) {
  const msg = String(body?.error?.message || body?.message || '').toLowerCase();
  const jitter = (ms) => Math.round(ms * (1 + rnd() * 0.25));
  if (timeout) return { kind: FAIL.TIMEOUT, openMs: jitter(20000) };
  if (network) return { kind: FAIL.NETWORK, openMs: jitter(30000) };
  if (status === 401 || status === 403) return { kind: FAIL.AUTH, openMs: 6 * 3600000, permanent: true };        // invalid credentials: do not retry continuously
  if (status === 429) {
    const daily = /per day|daily|tokens per day|requests per day|\bTPD\b|\bRPD\b/i.test(body?.error?.message || '') || /quota|exceeded your current/.test(msg);
    if (daily) { // wait for the provider's own hint, otherwise until the next UTC day starts
      const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      const hint = retryAfterSec > 0 ? retryAfterSec * 1000 : next - now.getTime();
      return { kind: FAIL.QUOTA, openMs: Math.min(Math.max(hint, 60000), 24 * 3600000) };
    }
    return { kind: FAIL.RATE, openMs: jitter(Math.min(Math.max((retryAfterSec || 30) * 1000, 5000), 15 * 60000)) };
  }
  if (status === 404 || (status === 400 && /model|decommission|not found|not supported/.test(msg))) return { kind: FAIL.MODEL, openMs: 6 * 3600000, permanent: true }; // wrong model name: needs an admin
  if (status >= 500 || status === 408) return { kind: FAIL.ERROR, openMs: jitter(30000) };
  return { kind: FAIL.ERROR, openMs: jitter(15000) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createAiClient({ store, fetchImpl = fetch, env = process.env, now = () => new Date(), random = Math.random, wait = sleep, getLimits } = {}) {
  const cfg = () => ({
    key: env.GROQ_API_KEY, model: env.GROQ_MODEL, base: (env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
    enabled: String(env.GROQ_ENABLED ?? 'true').toLowerCase() !== 'false', timeout: Number(env.GROQ_TIMEOUT_MS) || 10000, retries: Math.max(0, Number(env.GROQ_MAX_RETRIES ?? 1)),
  });
  const configured = () => { const c = cfg(); return !!(c.enabled && c.key && c.model); };

  /** Can we call the provider right now? (kill switch, configuration, circuit breaker, global and per-restaurant limits) */
  async function availability(restaurantId) {
    const c = cfg(); const lim = (await getLimits?.()) || {};
    if (lim.disabled) return { ok: false, kind: FAIL.OFF, why: 'ai_disabled_by_admin' };
    if (!configured()) return { ok: false, kind: FAIL.OFF, why: !c.key ? 'no_api_key' : !c.model ? 'no_model' : 'groq_disabled' };
    const st = await store.getState();
    const t = now().getTime();
    if (st.state === 'open' && st.openUntil && new Date(st.openUntil).getTime() > t) return { ok: false, kind: FAIL.OPEN, why: st.reason || 'provider_unavailable', until: st.openUntil };
    if (st.state === 'open') { // cool-down over: exactly ONE caller (across all server instances) gets to probe
      if (!(await store.claimProbe(new Date(t + 30000)))) return { ok: false, kind: FAIL.OPEN, why: 'probing' };
    }
    const u = await store.usage(restaurantId);
    if (lim.globalDailyRequests > 0 && u.globalDay >= lim.globalDailyRequests) return { ok: false, kind: FAIL.LIMIT, why: 'global_daily_limit' };
    if (restaurantId && lim.perRestaurantDailyRequests > 0 && u.restaurantDay >= lim.perRestaurantDailyRequests) return { ok: false, kind: FAIL.LIMIT, why: 'restaurant_daily_limit' };
    if (restaurantId && lim.perRestaurantMonthlyRequests > 0 && u.restaurantMonth >= lim.perRestaurantMonthlyRequests) return { ok: false, kind: FAIL.LIMIT, why: 'restaurant_monthly_limit' };
    return { ok: true };
  }

  /**
   * Asks the model for a JSON object. Resolves { ok:true, json, tokens } or { ok:false, kind, fallback:true }. NEVER throws.
   * `meta` = { restaurantId, conversationId, intentHint } for usage accounting.
   */
  async function chatJson({ system, user, meta = {}, maxTokens = 350 }) {
    const a = await availability(meta.restaurantId).catch(() => ({ ok: false, kind: FAIL.ERROR, why: 'availability_check_failed' }));
    if (!a.ok) { await store.recordUsage({ ...meta, status: a.kind === FAIL.LIMIT ? 'rejected' : 'rejected', fallback: true, skipped: true }).catch(() => {}); return { ok: false, kind: a.kind, why: a.why, fallback: true }; }
    const c = cfg();
    let lastFail = null;
    for (let attempt = 0; attempt <= c.retries; attempt++) {
      const started = Date.now();
      let res, data, fail = null;
      try {
        res = await fetchImpl(`${c.base}/chat/completions`, {
          method: 'POST', signal: AbortSignal.timeout(c.timeout),
          headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: c.model, temperature: 0, max_tokens: maxTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
        });
        data = await res.json().catch(() => null);
      } catch (e) { fail = classifyAiError({ timeout: e?.name === 'TimeoutError' || e?.name === 'AbortError', network: !(e?.name === 'TimeoutError' || e?.name === 'AbortError') }, now(), random); }
      const latencyMs = Date.now() - started;
      if (!fail && !res.ok) fail = classifyAiError({ status: res.status, body: data, retryAfterSec: Number(res.headers?.get?.('retry-after')) || 0 }, now(), random);
      if (!fail) {
        let json = null; try { json = JSON.parse(data?.choices?.[0]?.message?.content); } catch { /* malformed */ }
        const usage = data?.usage || {};
        if (json && typeof json === 'object' && !Array.isArray(json)) {
          await store.recordUsage({ ...meta, status: 'ok', inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0, latencyMs, model: c.model }).catch(() => {});
          await store.markSuccess().catch(() => {});
          return { ok: true, json, tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0) };
        }
        await store.recordUsage({ ...meta, status: 'malformed', inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0, latencyMs, model: c.model, fallback: true }).catch(() => {});
        return { ok: false, kind: FAIL.MALFORMED, fallback: true }; // a bad answer is not a provider outage: no breaker, just fall back for this message
      }
      lastFail = fail;
      await store.recordUsage({ ...meta, status: fail.kind, latencyMs, model: c.model, fallback: true }).catch(() => {});
      // Retry only short-lived trouble, and only a limited number of times with exponential backoff + jitter. Never 429/quota/auth/model.
      const retryable = [FAIL.TIMEOUT, FAIL.NETWORK, FAIL.ERROR].includes(fail.kind);
      if (!retryable || attempt >= c.retries) break;
      await wait(Math.round(300 * 2 ** attempt * (1 + random() * 0.5)));
    }
    await store.trip({ kind: lastFail.kind, openMs: lastFail.openMs, permanent: !!lastFail.permanent, message: `${lastFail.kind}` }).catch(() => {});
    return { ok: false, kind: lastFail.kind, fallback: true };
  }

  return { chatJson, availability, configured, model: () => cfg().model || null };
}
