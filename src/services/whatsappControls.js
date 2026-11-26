// WhatsApp on/off controls: the RULES. Pure functions with no database or network access, so they are unit-tested (test/whatsappControls.test.js).
// whatsappControlsStore.js applies them to the database.
//
// Three controls that are deliberately INDEPENDENT of each other:
//   1. Connection   - is the restaurant's own WhatsApp Business number connected to Ordarly?   (connectionStatus)
//   2. Automation   - may Ordarly itself start/send automated replies, menus, ordering conversations and follow-ups?   (automationEnabled)
//   3. Accept orders - may customers create NEW orders through WhatsApp?   (acceptOrdersEnabled)
// Turning automation or orders off never disconnects the account, and turning orders off never switches the support inbox off.

export const STATUSES = ['not_connected', 'connecting', 'connected', 'verification_pending', 'action_required', 'disconnected', 'restricted', 'connection_expired'];

/** Plain-language label and "what to do" for every connection status (shown in the dashboard). */
export const STATUS_INFO = {
  not_connected: { label: 'Not connected', help: 'Connect your own WhatsApp Business number to start receiving customer messages in Ordarly.' },
  connecting: { label: 'Connecting', help: 'Your connection is being set up. This normally takes a few minutes. If it stays like this, disconnect and try again.' },
  connected: { label: 'Connected', help: 'Your WhatsApp number is connected. Customer messages are being received.' },
  verification_pending: { label: 'Verification pending', help: 'Meta is still verifying your number or business. Finish any steps Meta has asked for in Meta Business Suite. Nothing is sent until verification is complete.' },
  action_required: { label: 'Action required', help: 'Meta needs you to do something before messaging can continue. Open Meta Business Suite to see what is required, then reconnect if asked.' },
  disconnected: { label: 'Disconnected', help: 'WhatsApp is disconnected. Your past conversations, orders and credit history are kept. Reconnect any time. Automation and order acceptance stay off until you switch them on again.' },
  restricted: { label: 'Restricted', help: 'Meta has restricted this WhatsApp account. Check the account quality and restriction notices in Meta Business Suite. Ordarly cannot lift a Meta restriction.' },
  connection_expired: { label: 'Connection expired', help: 'Your authorisation with Meta has expired. Reconnect WhatsApp to continue receiving messages.' },
};

export const isSuspended = (integ) => !!integ?.suspended?.at;
/** Connected AND not suspended by the Ordarly administrator. A suspended number sends nothing and takes no new orders. */
export const isConnected = (integ) => integ?.connectionStatus === 'connected' && !isSuspended(integ);

/** What is really happening right now: a control is only ACTIVE when it is switched on AND the number is connected. */
export function evaluate(integ) {
  const connected = isConnected(integ);
  const automationEnabled = !!integ?.automationEnabled, acceptOrdersEnabled = !!integ?.acceptOrdersEnabled;
  return {
    connected, status: integ?.connectionStatus || 'not_connected',
    automationEnabled, automationActive: connected && automationEnabled,
    acceptOrdersEnabled, ordersActive: connected && acceptOrdersEnabled,
  };
}

const REASONS = {
  not_connected: 'WhatsApp is not connected.',
  suspended: 'WhatsApp has been suspended for this restaurant by Ordarly.',
  automation_off: 'Automation is switched off.',
  stale_queue: 'This message was queued before automation was switched off, so it is cancelled.',
  predates_enable: 'The customer message arrived before automation was switched on, so it will not be answered automatically.',
  orders_off: 'This restaurant is not taking WhatsApp orders right now.',
};

/**
 * May an AUTOMATED message be sent right now? Call this immediately before every automated send, with a FRESH integration record (never a cached one).
 *  - epoch:     the integration's automationEpoch when the message was queued. Every time automation is switched on or off the epoch changes, so a
 *               message queued before a switch-off can never be sent after switching back on ("re-enabling must not send old queued messages").
 *  - inboundAt: when the customer message being answered arrived. Messages from before automation was last switched on are never answered
 *               automatically, so re-enabling does not restart abandoned conversations with an unsolicited greeting.
 */
export function guardAutomatedSend(integ, { epoch, inboundAt } = {}) {
  const e = evaluate(integ);
  const no = (reason) => ({ ok: false, reason, message: REASONS[reason] });
  if (!e.connected) return no(isSuspended(integ) ? 'suspended' : 'not_connected');
  if (!e.automationEnabled) return no('automation_off');
  if (epoch !== undefined && epoch !== (integ.automationEpoch || 0)) return no('stale_queue');
  if (inboundAt && integ.automationEnabledAt && new Date(inboundAt) < new Date(integ.automationEnabledAt)) return no('predates_enable');
  return { ok: true };
}

/** A staff member replying from the Ordarly inbox is NOT automation: it only needs a live connection. */
export function guardManualSend(integ) {
  if (isConnected(integ)) return { ok: true };
  const reason = isSuspended(integ) ? 'suspended' : 'not_connected';
  return { ok: false, reason, message: REASONS[reason] };
}

/** May a customer create a NEW order through WhatsApp? Existing orders are never affected by this. */
export function guardOrderCreation(integ) {
  const e = evaluate(integ);
  if (!e.connected) { const reason = isSuspended(integ) ? 'suspended' : 'not_connected'; return { ok: false, reason, message: REASONS[reason] }; }
  if (!e.acceptOrdersEnabled) return { ok: false, reason: 'orders_off', message: REASONS.orders_off };
  return { ok: true };
}

/**
 * What the conversation engine should do with a customer message that just arrived (it is always stored, whatever this says):
 *   'none'      - not connected; nothing to do
 *   'manual'    - automation is off (or the message predates it): store it, notify staff, never reply automatically
 *   'info_only' - automation is on but orders are off: only informational replies, with the restaurant's online ordering link
 *   'full'      - automation and orders are both on
 */
export function inboundMode(integ, { messageAt } = {}) {
  const e = evaluate(integ);
  if (!e.connected) return 'none';
  if (!guardAutomatedSend(integ, { inboundAt: messageAt }).ok) return 'manual';
  return e.acceptOrdersEnabled ? 'full' : 'info_only';
}

/**
 * Turns a requested change into exactly what must be written, or an error. Only controls whose value really changes are touched,
 * so repeating a request is harmless (no extra log entries, and the queue epoch is not bumped).
 */
export function planControlChange(current, patch, now = new Date()) {
  const e = evaluate(current);
  const set = {}, changes = [];
  for (const [field, control] of [['automationEnabled', 'automation'], ['acceptOrdersEnabled', 'orders']]) {
    if (patch[field] === undefined) continue;
    const to = !!patch[field], from = !!current?.[field];
    if (to === from) continue;
    if (to && !e.connected) return { error: 'Connect WhatsApp first. Automation and order acceptance can only be switched on while your number is connected.', code: 'NOT_CONNECTED' };
    set[field] = to;
    set[`changes.${control}`] = { at: now };
    changes.push({ control, from: from ? 'on' : 'off', to: to ? 'on' : 'off' });
    if (control === 'automation') { set.automationEpoch = (current?.automationEpoch || 0) + 1; if (to) set.automationEnabledAt = now; }
  }
  return { set, changes };
}

/** Disconnecting: status changes, the stored token is wiped, and everything is switched off so a later reconnect cannot start sending by itself. History is never deleted. */
export function planDisconnect(current, now = new Date()) {
  const changes = [{ control: 'connection', from: STATUS_INFO[current?.connectionStatus]?.label || 'Not connected', to: 'Disconnected' }];
  const set = { connectionStatus: 'disconnected', encryptedAccessToken: null, tokenExpiresAt: null, 'changes.connection': { at: now } };
  if (current?.automationEnabled) { set.automationEnabled = false; set.automationEpoch = (current.automationEpoch || 0) + 1; set['changes.automation'] = { at: now }; changes.push({ control: 'automation', from: 'on', to: 'off' }); }
  if (current?.acceptOrdersEnabled) { set.acceptOrdersEnabled = false; set['changes.orders'] = { at: now }; changes.push({ control: 'orders', from: 'on', to: 'off' }); }
  return { set, changes };
}
