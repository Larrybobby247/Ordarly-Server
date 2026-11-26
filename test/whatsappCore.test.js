import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import * as P from '../src/services/whatsappPayloads.js';
import * as E from '../src/services/whatsappErrors.js';
import * as C from '../src/services/whatsappCreditsMath.js';

test('signature: valid, tampered, missing', () => {
  const body = Buffer.from('{"a":1}'); const sec = 's3cret';
  const h = 'sha256=' + crypto.createHmac('sha256', sec).update(body).digest('hex');
  assert.equal(P.verifySignature(body, h, sec), true);
  assert.equal(P.verifySignature(Buffer.from('{"a":2}'), h, sec), false);
  assert.equal(P.verifySignature(body, undefined, sec), false);
  assert.equal(P.verifySignature(body, h, ''), false);
  assert.equal(P.verifySignature(body, 'sha256=abc', sec), false);
});
test('challenge', () => {
  assert.equal(P.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '123' }, 'x'), '123');
  assert.equal(P.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'y', 'hub.challenge': '123' }, 'x'), null);
  assert.equal(P.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }, ''), null);
});
test('identity: phone, bsuid, none', () => {
  assert.equal(P.customerIdentity({ wa_id: '2348012345678', profile: { name: 'A' } }, {}).key, '2348012345678');
  assert.equal(P.customerIdentity({ user_id: 'U1' }, {}).key, 'bsuid:U1');
  assert.equal(P.customerIdentity({}, {}), null);
});
test('parseWebhook: messages, statuses, echoes, account; stable keys', () => {
  const body = { object: 'whatsapp_business_account', entry: [{ id: 'W1', changes: [
    { field: 'messages', value: { metadata: { phone_number_id: 'P1' }, contacts: [{ wa_id: '234' }], messages: [{ id: 'm1', from: '234', type: 'text', text: { body: 'hi' }, timestamp: '1700000000' }], statuses: [{ id: 'o1', status: 'delivered', timestamp: '1' }] } },
    { field: 'smb_message_echoes', value: { message_echoes: [{ id: 'e1' }] } },
    { field: 'account_update', value: { event: 'X' } },
  ] }] };
  const ev = P.parseWebhook(body);
  assert.deepEqual(ev.map((e) => e.kind), ['message', 'status', 'echo', 'account']);
  assert.equal(ev[0].phoneNumberId, 'P1');
  assert.deepEqual(P.parseWebhook(body).map((e) => e.key), ev.map((e) => e.key));
  assert.deepEqual(P.parseWebhook({ object: 'page' }), []);
});
test('normalizeInbound', () => {
  assert.equal(P.normalizeInbound({ id: 'a', type: 'interactive', interactive: { button_reply: { id: 'b1', title: 'Yes' } } }).buttonId, 'b1');
  assert.equal(P.normalizeInbound({ id: 'a', type: 'location', location: { latitude: 6.5, longitude: 3.3 } }).location.lat, 6.5);
  assert.equal(P.normalizeInbound({ id: 'a', type: 'location', location: { latitude: 999, longitude: 3 } }).location, null);
  assert.equal(P.normalizeInbound({ id: 'a', type: 'weird' }).type, 'unsupported');
});
test('builders respect Meta limits', () => {
  const b = P.buttons('x'.repeat(2000), [1, 2, 3, 4].map((i) => ({ id: 'b' + i, title: 'T'.repeat(40) })));
  const i = b.payload.interactive;
  assert.ok(i.body.text.length <= 1024);
  assert.ok(i.action.buttons.length <= 3);
  assert.ok(i.action.buttons.every((x) => x.reply.title.length <= 20));
  const rows = Array.from({ length: 15 }, (_, n) => ({ id: 'r' + n, title: 'R'.repeat(50), description: 'D'.repeat(200) }));
  const l = P.list('body', 'Pick one please long label', rows).payload.interactive;
  const all = l.action.sections.flatMap((s) => s.rows);
  assert.ok(all.length <= 10);
  assert.ok(all.every((r) => r.title.length <= 24 && (r.description || '').length <= 72));
  assert.ok(l.action.button.length <= 20);
  assert.ok(P.text('y'.repeat(5000)).payload.text.body.length <= 4096);
});
test('toMetaRequest: phone vs bsuid', () => {
  const t = P.text('hi');
  const a = P.toMetaRequest('234', t); const b = P.toMetaRequest('bsuid:U9', t);
  assert.equal(a.messaging_product, 'whatsapp'); assert.equal(a.to, '234');
  assert.equal(b.recipient, 'U9'); assert.equal(b.to, undefined);
});
test('error classification', () => {
  assert.equal(E.classifyMetaError({ code: 131047 }).kind, 'window_closed');
  assert.equal(E.classifyMetaError({ code: 131026 }).retry, false);
  assert.equal(E.classifyMetaError({ code: 190 }).integrationStatus, 'connection_expired');
  assert.equal(E.classifyMetaError({ code: 131042 }).kind, 'meta_payment');
  assert.equal(E.classifyMetaError({ code: 130429 }).retry, true);
  assert.equal(E.classifyMetaError({ code: 131049 }).retry, false);
  assert.equal(E.classifyMetaError({ httpStatus: 503 }).kind, 'temporary');
  assert.equal(E.classifyMetaError({ network: true }).retry, true);
  assert.equal(E.classifyMetaError({ httpStatus: 400, code: 99999 }).kind, 'invalid_request');
});
test('backoff grows and caps', () => {
  const z = () => 0;
  assert.equal(E.backoffMs(1, z), 30000); assert.equal(E.backoffMs(2, z), 60000);
  assert.equal(E.backoffMs(20, z), 900000);
});
test('credits: cycles', () => {
  const now = new Date('2026-03-10T00:00:00Z');
  const f = C.computeCycle({ plan: 'free', restaurantCreatedAt: new Date('2026-01-31T00:00:00Z'), now });
  assert.equal(f.start.toISOString().slice(0, 10), '2026-02-28');
  assert.equal(f.id, 'free:' + f.start.toISOString());
  const p = C.computeCycle({ plan: 'pro', subscription: { periodStart: new Date('2026-01-05T00:00:00Z'), periodEnd: new Date('2027-01-05T00:00:00Z') }, now });
  assert.equal(p.start.toISOString().slice(0, 10), '2026-03-05');
  assert.equal(p.end.toISOString().slice(0, 10), '2026-04-05');
  const again = C.computeCycle({ plan: 'pro', subscription: { periodStart: new Date('2026-01-05T00:00:00Z'), periodEnd: new Date('2027-01-05T00:00:00Z') }, now: new Date('2026-03-20T00:00:00Z') });
  assert.equal(again.id, p.id);
});
test('credits: pools and warnings', () => {
  assert.equal(C.pickPool({ monthlyAllowance: 5, monthlyUsed: 5, purchasedBalance: 2 }), 'purchased');
  assert.equal(C.pickPool({ monthlyAllowance: 5, monthlyUsed: 4, reservedMonthly: 1, purchasedBalance: 2 }), 'purchased');
  assert.equal(C.pickPool({ monthlyAllowance: 5, monthlyUsed: 0, purchasedBalance: 2 }), 'monthly');
  assert.equal(C.pickPool({ monthlyAllowance: 1, monthlyUsed: 1, purchasedBalance: 0 }), null);
  const w = (u) => ({ monthlyAllowance: 100, monthlyUsed: u });
  assert.equal(C.warningLevel(w(50)), null); assert.equal(C.warningLevel(w(75)), 'p25');
  assert.equal(C.warningLevel(w(90)), 'p10'); assert.equal(C.warningLevel(w(100)), 'zero');
  assert.equal(C.warningLevel({ ...w(100), purchasedBalance: 500 }), null);
  assert.equal(C.allowanceFor({ allowances: { pro: 7 } }, 'pro'), 7);
  assert.equal(C.allowanceFor({}, 'free'), 100);
});
test('credits: FIFO packs', () => {
  const r = C.packsRemaining([{ id: 'a', amount: 10 }, { id: 'b', amount: 5 }], 12);
  assert.deepEqual(r.map((x) => x.remaining), [0, 3]);
});

import * as Ctl from '../src/services/whatsappControls.js';
test('suspended integrations send nothing and take no orders', () => {
  const i = { connectionStatus: 'connected', automationEnabled: true, acceptOrdersEnabled: true, suspended: { at: new Date() } };
  assert.equal(Ctl.guardAutomatedSend(i).reason, 'suspended');
  assert.equal(Ctl.guardManualSend(i).reason, 'suspended');
  assert.equal(Ctl.guardOrderCreation(i).reason, 'suspended');
  assert.equal(Ctl.inboundMode(i), 'none');
  assert.equal(Ctl.guardAutomatedSend({ ...i, suspended: undefined }).ok, true);
});

import { staffRouteAllowed, buildAccess } from '../src/services/access.js';
test('staff can reach only the WhatsApp inbox, and only with the Orders permission', () => {
  const withOrders = { isOwner: false, perms: new Set(['orders']), allBranches: true, branchIds: [] };
  const without = { isOwner: false, perms: new Set(['menu']), allBranches: true, branchIds: [] };
  assert.equal(staffRouteAllowed(withOrders, 'GET', '/api/whatsapp/inbox/conversations'), true);
  assert.equal(staffRouteAllowed(without, 'GET', '/api/whatsapp/inbox/conversations'), false);
  for (const p of ['/api/whatsapp/controls', '/api/whatsapp/credits', '/api/whatsapp/settings', '/api/whatsapp/embedded-signup', '/api/admin/whatsapp/overview'])
    assert.equal(staffRouteAllowed(withOrders, 'POST', p), false, p);
});
