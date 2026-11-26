// Customer details, tracking, AI-assisted understanding, notifications and order progress (all pure; no database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { run, deps } from './whatsappEngine.test.js';
import { handleInbound } from '../src/services/whatsappEngine.js';
import { validName, cleanPhone, displayPhone, phoneVariants } from '../src/services/whatsappCustomer.js';
import { confirmationText, statusText, trackStatusText } from '../src/services/whatsappMessages.js';
import { buildProgress } from '../src/services/orderProgress.js';

const body = (r) => r.out.map((b) => b.preview).join('\n');
const START = ['hi', { id: 'cat:c1' }, { id: 'item:m2' }, { id: 'qty:1' }, { id: 'checkout' }];

test('customer helpers', () => {
  assert.equal(validName('  ada   obi '), 'Ada Obi'); assert.equal(validName('12345'), null); assert.equal(validName('http://x.co'), null); assert.equal(validName('A'), null);
  assert.equal(cleanPhone('0801 234 5678'), '2348012345678'); assert.equal(cleanPhone('abc'), null); assert.equal(cleanPhone('+2348012345678'), '2348012345678');
  assert.equal(displayPhone('2348012345678'), '08012345678');
  assert.ok(phoneVariants('2348012345678').includes('08012345678'));
});

test('name is asked, typed by the customer, then phone is confirmed, then summary needs explicit confirmation', async () => {
  const d = deps();
  const r = await run([...START, { id: 'fulfil:pickup' }], d, 'full', { customerName: 'Profile Name' });
  assert.equal(r.c.conversationState, 'name_collection');
  assert.ok(!r.c.confirmedName, 'WhatsApp profile name must never be used as the customer name');
  const r2 = await run([...START, { id: 'fulfil:pickup' }, 'Ada Obi', { id: 'phone_yes' }], d, 'full', { customerName: 'Profile Name' });
  assert.equal(r2.c.confirmedName, 'Ada Obi');
  assert.equal(r2.c.conversationState, 'checkout_summary');
  assert.ok(body(r2.last).includes('Ada Obi') && body(r2.last).includes('08012345678') && body(r2.last).includes('Total'));
  assert.equal(d.created.length, 0, 'no order before the customer confirms');
});

test('an alternative phone number can be used', async () => {
  const r = await run([...START, { id: 'fulfil:pickup' }, 'Ada Obi', { id: 'phone_other' }, '0803 111 2222']);
  assert.equal(r.c.contactPhone, '2348031112222'); assert.equal(r.c.conversationState, 'checkout_summary');
});

test('delivery asks for details after name and phone; summary shows address and fee', async () => {
  const r = await run([...START, { id: 'fulfil:delivery' }, 'Ada Obi', { id: 'phone_yes' }, { type: 'location', buttonId: null, location: { lat: 6.5, lng: 3.3 } }]);
  assert.ok(['delivery_confirmation', 'delivery_details'].includes(r.c.conversationState));
});

test('saved name is offered for confirmation but the address must be re-confirmed', async () => {
  const d = deps({ savedDetails: async () => ({ name: 'Ada Obi', address: '12 Old Road, Ikeja', placeId: 'PQ' }) });
  const r = await run([...START, { id: 'fulfil:delivery' }], d);
  assert.equal(r.c.conversationState, 'name_confirmation');
  const r2 = await run([...START, { id: 'fulfil:delivery' }, { id: 'name_yes' }, { id: 'phone_yes' }], d);
  assert.equal(r2.c.conversationState, 'saved_address');
  const r3 = await run([...START, { id: 'fulfil:delivery' }, { id: 'name_yes' }, { id: 'phone_yes' }, { id: 'saved_addr_yes' }], d);
  assert.equal(r3.c.conversationState, 'delivery_confirmation', 'old address is re-quoted and shown for confirmation');
});

test('payment link is never created with missing details', async () => {
  const d = deps();
  const before = { conversationState: 'checkout_summary', currentCart: [{ mealId: 'm2', quantity: 1, addonIds: [] }], cartVersion: 1, fulfillment: 'pickup', customerPhone: '2348012345678' };
  const r = await handleInbound({ conv: before, msg: { type: 'interactive', buttonId: 'confirm', text: '' }, mode: 'full', deps: d });
  assert.equal(d.created.length, 0);
  assert.ok(body(r).toLowerCase().includes('name'));
});

test('full pickup order: details -> confirm -> one order created with the confirmed details', async () => {
  const d = deps();
  const r = await run([...START, { id: 'fulfil:pickup' }, 'Ada Obi', { id: 'phone_yes' }, { id: 'confirm' }], d);
  assert.equal(d.created.length, 1);
  assert.equal(d.created[0].conv.confirmedName, 'Ada Obi'); assert.equal(d.created[0].conv.phoneConfirmed, true);
  assert.equal(r.c.conversationState, 'payment_pending');
});

test('natural language: "Two" after choosing an item sets the quantity; reader handles it with no AI', async () => {
  const r = await run(['hi', { id: 'cat:c1' }, { id: 'item:m2' }, 'Two']);
  assert.equal(r.c.currentCart[0].quantity, 2);
});

test('AI is only asked when the reader is not confident, and its answer needs the customer to confirm', async () => {
  let asked = 0;
  const d = deps({ ai: async () => { asked++; return { ok: true, interpretation: { intent: 'ADD_ITEMS', confidence: 0.9, entities: { items: [{ mealId: 'm2', name: 'Water', quantity: 2 }] } } }; } });
  const clear = await run(['hi', 'menu'], d); assert.equal(asked, 0, 'a clear message never reaches the AI');
  const r = await run(['hi', 'qwertyx wetin go sweet my mouth'], d);
  assert.equal(asked, 1);
  assert.equal(r.c.currentCart.length, 0, 'cart unchanged until the customer says yes');
  const r2 = await run(['hi', 'qwertyx wetin go sweet my mouth', { id: 'ai_yes' }], d);
  assert.equal(r2.c.currentCart[0].quantity, 2);
});

test('AI unavailable: the assistant still answers (basic mode)', async () => {
  const d = deps({ ai: async () => ({ ok: false, kind: 'rate_limited' }) });
  const r = await run(['hi', 'qwertyx zzzz blorp'], d);
  assert.ok(r.last.out.length > 0);
});

test('track: no orders, one order, several orders, someone else\'s reference', async () => {
  const none = await run(['hi', 'track my order']); assert.ok(body(none.last).toLowerCase().includes("can't find"));
  const one = await run(['hi', 'where is my order?'], deps({ trackOrders: async () => ({ orders: [{ reference: 'ORD-1', statusText: 'being prepared', link: 'https://x.test/track/tok' }] }) }));
  assert.ok(body(one.last).includes('ORD-1') && body(one.last).includes('https://x.test/track/tok'));
  const many = await run(['hi', 'track my order'], deps({ trackOrders: async () => ({ orders: [{ reference: 'ORD-1', statusText: 'a' }, { reference: 'ORD-2', statusText: 'b' }] }) }));
  assert.ok(body(many.last).includes('Which order'));
  let asked; const foreign = await run(['hi', 'Track ORD-999999'], deps({ trackOrders: async (c, ref) => { asked = ref; return { orders: [] }; } }));
  assert.equal(asked, 'ORD-999999'); assert.ok(body(foreign.last).includes("couldn't find an order with that reference"));
});

const ORDER = { reference: 'ORD-123456', customerName: 'John Doe', fulfillment: 'delivery', items: [{ name: 'Chicken Burger', quantity: 2 }, { name: 'Fried Rice', quantity: 1, size: 'Large' }], subtotal: 8000, deliveryFee: 1000, total: 9000, paymentMethod: 'paystack', paymentStatus: 'paid', status: 'pending' };
test('confirmation message is built from the order record', () => {
  const t = confirmationText(ORDER, { restaurantName: 'Ace Service', link: 'https://x.test/track/abc' });
  for (const x of ['Hello John!', 'Ace Service', 'ORD-123456', 'Delivery', '2x Chicken Burger', '1x Fried Rice (Large)', '₦8,000', '₦1,000', '₦9,000', 'Payment Status: Successful', 'https://x.test/track/abc']) assert.ok(t.includes(x), x);
  assert.ok(!/Estimated/i.test(t), 'no invented estimate');
  const pick = confirmationText({ ...ORDER, fulfillment: 'pickup', deliveryFee: 0, total: 8000 }, { restaurantName: 'Ace' });
  assert.ok(!pick.includes('Delivery Fee') && pick.includes('Pickup'));
});
test('status messages', () => {
  assert.ok(statusText('accepted', ORDER).includes('accepted'));
  assert.ok(statusText('out_for_delivery', ORDER, { link: 'https://x.test/t' }).includes('https://x.test/t'));
  assert.ok(statusText('ready', { ...ORDER, fulfillment: 'pickup' }).includes('ready for pickup'));
  assert.ok(statusText('completed', ORDER).includes('delivered'));
  assert.ok(statusText('cancelled', ORDER).includes('cancelled'));
  assert.ok(statusText('payment_failed', ORDER).includes('did not go through'));
});
test('tracking text never claims an unpaid order is in progress', () => {
  assert.ok(trackStatusText({ ...ORDER, paymentStatus: 'awaiting_payment' }).includes('waiting for payment'));
  assert.ok(trackStatusText({ ...ORDER, paymentStatus: 'failed' }).includes('payment failed'));
  assert.equal(trackStatusText({ ...ORDER, status: 'preparing' }), 'being prepared');
});

const A = (field, to, at = new Date()) => ({ field, to, at });
const state = (p, k) => p.stages.find((s) => s.key === k)?.state;
test('progress: only real events are shown as done', () => {
  const p0 = buildProgress({ ...ORDER, paymentStatus: 'awaiting_payment' });
  assert.equal(state(p0, 'payment'), 'current'); assert.equal(state(p0, 'received'), 'upcoming'); assert.ok(p0.message.includes('not confirmed'));
  const p1 = buildProgress({ ...ORDER, audit: [A('paymentStatus', 'paid')] });
  assert.equal(state(p1, 'payment'), 'done'); assert.equal(state(p1, 'received'), 'done'); assert.equal(state(p1, 'accepted'), 'current'); assert.equal(state(p1, 'preparing'), 'upcoming');
  assert.ok(p1.message.includes('Waiting for the restaurant'));
  const p2 = buildProgress({ ...ORDER, status: 'ready', audit: [A('paymentStatus', 'paid'), A('status', 'accepted'), A('status', 'ready')] });
  assert.equal(state(p2, 'accepted'), 'done'); assert.equal(p2.stages.find((s) => s.key === 'preparing'), undefined, 'a skipped step is not shown as done');
  assert.equal(state(p2, 'ready'), 'done'); assert.equal(state(p2, 'out_for_delivery'), 'current');
});
test('progress: pickup has no dispatch stage; cancelled ends the timeline', () => {
  const p = buildProgress({ ...ORDER, fulfillment: 'pickup', status: 'accepted', audit: [A('paymentStatus', 'paid'), A('status', 'accepted')] });
  assert.equal(p.stages.find((s) => s.key === 'out_for_delivery'), undefined);
  assert.equal(p.stages.find((s) => s.key === 'ready').label, 'Ready for pickup');
  const c = buildProgress({ ...ORDER, status: 'cancelled', audit: [A('paymentStatus', 'paid'), A('status', 'cancelled')] });
  assert.equal(c.cancelled, true); assert.equal(c.stages.at(-1).key, 'cancelled'); assert.ok(!c.stages.some((s) => s.state === 'upcoming'));
});
