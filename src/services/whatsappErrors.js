// Turns a Meta send error into plain language and a decision (retry or not). Pure and unit-tested.
// Error codes come from Meta's current WhatsApp Cloud API error-code reference. Decisions are made on the numeric `code`, never on titles.
//
// kinds (each is shown to the restaurant differently):
//   meta_limit | meta_restricted | meta_payment | invalid_recipient | template | window_closed | token_expired | temporary | network | invalid_request | unknown
// (a separate 'credits' kind is raised by Ordarly itself when its own credits run out: it never comes from Meta.)

const SETS = {
  window_closed: [131047, 131051],
  invalid_recipient: [131026, 130403, 131009, 131021, 131030],
  meta_limit: [130429, 131056, 131048, 131049, 131050, 131064, 80007, 4, 80008, 613],
  meta_payment: [131042, 134011, 10],
  meta_restricted: [368, 131031, 130497, 131053],
  token_expired: [190, 0, 200, 3, 131005],
  temporary: [1, 2, 131016, 133004, 131000, 135000, 131057, 2494100, 131052],
  template: [132000, 132001, 132005, 132007, 132012, 132015, 132016, 132018, 131055, 131063, 2388019, 2388039],
};
const kindOf = (code) => Object.keys(SETS).find((k) => SETS[k].includes(code)) || null;

const TEXT = {
  window_closed: 'The customer last wrote more than 24 hours ago, so WhatsApp only allows an approved template message now.',
  invalid_recipient: 'WhatsApp could not deliver to this customer. Their number may not be on WhatsApp, they may have blocked your business, or their WhatsApp is out of date.',
  meta_limit: "WhatsApp is limiting how many messages your number can send right now (a Meta messaging limit or rate limit). Buying Ordarly credits does not lift this. Try again later and check your number's quality in WhatsApp Manager.",
  meta_payment: "Meta could not charge your WhatsApp account. Check the payment method on your WhatsApp Business Account in Meta Business Suite.",
  meta_restricted: 'Meta has restricted or disabled this WhatsApp account. Review the notice in Meta Business Suite. Ordarly cannot lift a Meta restriction.',
  token_expired: 'Your WhatsApp authorisation with Meta has expired or been removed. Reconnect WhatsApp to continue.',
  temporary: 'WhatsApp had a temporary problem. Ordarly will try again automatically.',
  template: 'The message template was not accepted by Meta (missing, not yet approved, or rejected).',
  network: 'The connection to WhatsApp was interrupted. Ordarly will try again automatically.',
  invalid_request: 'WhatsApp rejected this message as invalid.',
  unknown: 'WhatsApp could not send this message.',
};

/**
 * @param {{ httpStatus?: number, code?: number|string, details?: string, network?: boolean }} e
 * @returns {{ kind, retry: boolean, message: string, code: string|null, integrationStatus?: string }}
 */
export function classifyMetaError({ httpStatus, code, details, network } = {}) {
  const c = code === undefined || code === null || code === '' ? null : Number(code);
  if (network) return { kind: 'network', retry: true, message: TEXT.network, code: null };
  let kind = c !== null ? kindOf(c) : null;
  if (!kind && c !== null && c >= 200 && c <= 299) kind = 'token_expired';
  if (!kind) kind = httpStatus >= 500 || httpStatus === 429 ? 'temporary' : httpStatus === 401 ? 'token_expired' : httpStatus === 400 ? 'invalid_request' : 'unknown';
  // Of the "limit" family only the burst/throughput ones are worth retrying soon; per-user marketing and policy limits are not.
  const retryable = kind === 'temporary' || kind === 'network' || (kind === 'meta_limit' && [130429, 80007, 4, 613, 80008].includes(c));
  const out = { kind, retry: retryable, message: TEXT[kind], code: c === null ? null : String(c) };
  if (kind === 'token_expired') out.integrationStatus = 'connection_expired';
  if (kind === 'meta_restricted') out.integrationStatus = 'restricted';
  if (kind === 'meta_payment') out.integrationStatus = 'action_required';
  if (details && kind !== 'temporary') out.detail = String(details).slice(0, 300);
  return out;
}

/** Does this kind need the restaurant owner to do something? (They are notified once, not on every failed message.) */
export const needsOwnerAction = (kind) => ['meta_restricted', 'meta_payment', 'token_expired', 'meta_limit', 'template'].includes(kind);

/** Wait before retry n (1-based): 30s, 1m, 2m, 4m, 8m... capped at 15 minutes, with up to 20% random spread so retries do not bunch up. */
export const backoffMs = (attempt, rnd = Math.random) => Math.min(30000 * 2 ** (attempt - 1), 15 * 60000) * (1 + rnd() * 0.2);
export const MAX_ATTEMPTS = 5;
