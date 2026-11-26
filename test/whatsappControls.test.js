import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STATUSES, STATUS_INFO, evaluate, guardAutomatedSend, guardManualSend, guardOrderCreation, inboundMode, planControlChange, planDisconnect } from '../src/services/whatsappControls.js';
import { encryptToken, decryptToken } from '../src/services/tokenVault.js';
import { unsubscribeApp } from '../src/services/whatsappMeta.js';

const live = (o = {}) => ({ connectionStatus: 'connected', automationEnabled: true, acceptOrdersEnabled: true, automationEpoch: 4, automationEnabledAt: new Date('2026-11-24T10:00:00Z'), ...o });

test('every status has a label and instructions, and matches the database model', () => {
  for (const s of STATUSES) assert.ok(STATUS_INFO[s]?.label && STATUS_INFO[s]?.help, s);
  const src = fs.readFileSync(new URL('../src/models/index.js', import.meta.url), 'utf8');
  const enumText = src.match(/connectionStatus: \{ type: String, enum: \[([^\]]+)\]/)[1];
  assert.deepEqual(enumText.match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1)), STATUSES);
});

test('a control is only ACTIVE when it is on AND the number is connected', () => {
  assert.deepEqual([evaluate(live()).automationActive, evaluate(live()).ordersActive], [true, true]);
  const off = evaluate(live({ connectionStatus: 'disconnected' }));
  assert.deepEqual([off.connected, off.automationActive, off.ordersActive], [false, false, false]);
  assert.equal(evaluate(undefined).status, 'not_connected');
});

test('automation OFF stops automated sends but not staff replies or the connection', () => {
  const i = live({ automationEnabled: false });
  assert.equal(guardAutomatedSend(i).ok, false); assert.equal(guardAutomatedSend(i).reason, 'automation_off');
  assert.equal(guardManualSend(i).ok, true);
  assert.equal(evaluate(i).connected, true);
});

test('orders OFF stops new orders but automation and the support inbox keep working', () => {
  const i = live({ acceptOrdersEnabled: false });
  assert.equal(guardOrderCreation(i).reason, 'orders_off');
  assert.equal(guardAutomatedSend(i).ok, true); assert.equal(guardManualSend(i).ok, true);
});

test('nothing is possible when disconnected, and nothing is on by default', () => {
  for (const s of STATUSES.filter((x) => x !== 'connected')) {
    const i = live({ connectionStatus: s });
    assert.equal(guardAutomatedSend(i).ok, false, s); assert.equal(guardOrderCreation(i).ok, false, s); assert.equal(guardManualSend(i).ok, false, s);
  }
  assert.equal(guardAutomatedSend({ connectionStatus: 'connected' }).ok, false); // a fresh record has both switches off
  assert.equal(guardOrderCreation({ connectionStatus: 'connected' }).ok, false);
});

test('inbound mode: none / manual / info_only / full', () => {
  const at = new Date('2026-11-24T11:00:00Z');
  assert.equal(inboundMode(live({ connectionStatus: 'disconnected' }), { messageAt: at }), 'none');
  assert.equal(inboundMode(live({ automationEnabled: false }), { messageAt: at }), 'manual');
  assert.equal(inboundMode(live({ acceptOrdersEnabled: false }), { messageAt: at }), 'info_only');
  assert.equal(inboundMode(live(), { messageAt: at }), 'full');
});

test('re-enabling never sends old queued messages: the queue epoch changes on every switch', () => {
  let i = live({ automationEnabled: true, automationEpoch: 4 });
  const queuedUnder = i.automationEpoch;
  const off = planControlChange(i, { automationEnabled: false }); i = { ...i, ...off.set };
  const on = planControlChange(i, { automationEnabled: true }); i = { ...i, ...on.set };
  assert.equal(i.automationEnabled, true); assert.equal(i.automationEpoch, 6);
  const g = guardAutomatedSend(i, { epoch: queuedUnder });
  assert.deepEqual([g.ok, g.reason], [false, 'stale_queue']);
  assert.equal(guardAutomatedSend(i, { epoch: 6 }).ok, true);
});
test('a message queued while automation is off is cancelled too', () => {
  const i = live({ automationEpoch: 4 }), q = i.automationEpoch;
  const off = { ...i, ...planControlChange(i, { automationEnabled: false }).set };
  assert.equal(guardAutomatedSend(off, { epoch: q }).ok, false);
});

test('re-enabling does not restart abandoned conversations: older customer messages are never answered automatically', () => {
  const t0 = new Date('2026-11-24T10:00:00Z'), later = new Date('2026-11-24T12:00:00Z');
  const i = live({ automationEnabledAt: later });
  assert.equal(guardAutomatedSend(i, { inboundAt: t0 }).reason, 'predates_enable');
  assert.equal(guardAutomatedSend(i, { inboundAt: new Date('2026-11-24T12:05:00Z') }).ok, true);
  assert.equal(inboundMode(i, { messageAt: t0 }), 'manual');
});

test('switching on needs a connection; repeating a change is a no-op (no log, no epoch bump)', () => {
  const dis = { connectionStatus: 'disconnected', automationEnabled: false, acceptOrdersEnabled: false, automationEpoch: 0 };
  const p = planControlChange(dis, { automationEnabled: true });
  assert.equal(p.code, 'NOT_CONNECTED');
  assert.equal(planControlChange(dis, { acceptOrdersEnabled: true }).code, 'NOT_CONNECTED');
  assert.equal(planControlChange(dis, { automationEnabled: false }).changes.length, 0); // turning OFF something already off is fine
  const i = live();
  const same = planControlChange(i, { automationEnabled: true, acceptOrdersEnabled: true });
  assert.deepEqual([same.changes.length, Object.keys(same.set).length], [0, 0]);
});

test('the two switches are independent: changing one never touches the other', () => {
  const i = live();
  const a = planControlChange(i, { automationEnabled: false });
  assert.equal(a.set.acceptOrdersEnabled, undefined); assert.deepEqual(a.changes.map((c) => c.control), ['automation']);
  const b = planControlChange(i, { acceptOrdersEnabled: false });
  assert.equal(b.set.automationEnabled, undefined); assert.equal(b.set.automationEpoch, undefined);
  const both = planControlChange(i, { automationEnabled: false, acceptOrdersEnabled: false });
  assert.deepEqual(both.changes.map((c) => c.control).sort(), ['automation', 'orders']);
});

test('disconnect wipes the token, switches everything off, and plans no deletion of history', () => {
  const p = planDisconnect(live());
  assert.equal(p.set.connectionStatus, 'disconnected'); assert.equal(p.set.encryptedAccessToken, null);
  assert.equal(p.set.automationEnabled, false); assert.equal(p.set.acceptOrdersEnabled, false); assert.equal(p.set.automationEpoch, 5);
  assert.deepEqual(p.changes.map((c) => c.control).sort(), ['automation', 'connection', 'orders']);
  // only fields of the integration record itself may be written: nothing about conversations, messages, orders or credits
  const allowed = new Set(['connectionStatus', 'encryptedAccessToken', 'tokenExpiresAt', 'automationEnabled', 'acceptOrdersEnabled', 'automationEpoch', 'changes.connection', 'changes.automation', 'changes.orders']);
  assert.deepEqual(Object.keys(p.set).filter((k) => !allowed.has(k)), []);
  // already-off controls are not logged again, and a later reconnect cannot start sending by itself
  const quiet = planDisconnect(live({ automationEnabled: false, acceptOrdersEnabled: false }));
  assert.deepEqual(quiet.changes.map((c) => c.control), ['connection']);
  const after = { ...live(), ...p.set, connectionStatus: 'connected' };
  assert.equal(guardAutomatedSend(after).ok, false); assert.equal(guardOrderCreation(after).ok, false);
});

/* ---------- token vault + Meta unsubscribe ---------- */
process.env.META_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
test('tokens are encrypted, round-trip, and are not stored in readable form', () => {
  const t = 'EAAG-secret-token-123'; const enc = encryptToken(t);
  assert.ok(!enc.includes(t)); assert.notEqual(enc, encryptToken(t)); assert.equal(decryptToken(enc), t);
  const bad = enc.slice(0, -2) + (enc.endsWith('AA') ? 'BB' : 'AA');
  assert.throws(() => decryptToken(bad));
  process.env.META_TOKEN_ENCRYPTION_KEY = 'short'; assert.throws(() => encryptToken('x'), (e) => e.status === 503);
  process.env.META_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
});
test('unsubscribe calls Meta with the restaurant\'s own WABA and token, and never throws', async () => {
  const real = globalThis.fetch; const calls = [];
  try {
    process.env.META_API_VERSION = 'v99.0';
    const stored = encryptToken('tok-1');
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, status: 200, json: async () => ({ success: true }) }; };
    assert.deepEqual(await unsubscribeApp({ wabaId: '123', encryptedAccessToken: stored }), { ok: true });
    assert.equal(calls[0].url, 'https://graph.facebook.com/v99.0/123/subscribed_apps'); assert.equal(calls[0].init.method, 'DELETE'); assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-1');
    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 190 } }) });
    assert.equal((await unsubscribeApp({ wabaId: '123', encryptedAccessToken: stored })).ok, false);
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal((await unsubscribeApp({ wabaId: '123', encryptedAccessToken: stored })).ok, false);
    assert.equal((await unsubscribeApp({ wabaId: '123' })).ok, false);
    delete process.env.META_API_VERSION; assert.match((await unsubscribeApp({ wabaId: '123', encryptedAccessToken: stored })).note, /META_API_VERSION/);
  } finally { globalThis.fetch = real; }
});
