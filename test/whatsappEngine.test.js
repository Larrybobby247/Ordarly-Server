import test from 'node:test';
import assert from 'node:assert/strict';
import { handleInbound, addToCart } from '../src/services/whatsappEngine.js';

const MEALS = { m1: { id: 'm1', name: 'Jollof', price: 2000, sizes: [{ id: 's1', name: 'Large', price: 3000 }], addons: [{ id: 'a1', name: 'Plantain', price: 500 }] }, m2: { id: 'm2', name: 'Water', price: 300, sizes: [], addons: [] } };
function deps(over = {}) {
  const created = [];
  return {
    created,
    restaurant: async () => ({ name: 'Mama Put', isOpen: true, menuUrl: 'https://x.test/r/mama', settings: {} }),
    categories: async () => [{ id: 'c1', name: 'Mains', count: 2 }],
    items: async () => [MEALS.m1, MEALS.m2],
    meal: async (id) => MEALS[id] || null,
    price: async (cart) => {
      const items = [], unavailable = [];
      for (const l of cart) { const m = MEALS[l.mealId]; if (!m) { unavailable.push(l.mealId); continue; } const unit = (l.sizeId ? 3000 : m.price) + (l.addonIds?.length || 0) * 500; items.push({ name: m.name, size: l.sizeId ? 'Large' : undefined, addons: (l.addonIds || []).map(() => ({ name: 'Plantain' })), price: unit, quantity: l.quantity }); }
      return { items, unavailable, subtotal: items.reduce((s, i) => s + i.price * i.quantity, 0) };
    },
    canOrder: async () => true,
    fulfilmentOptions: async () => ({ delivery: true, pickup: true }),
    paymentMethods: async () => ['online'],
    placeFromCoords: async () => 'PLACE',
    searchAddress: async () => [{ placeId: 'P1', main: 'Ikeja', secondary: 'Lagos', text: 'Ikeja, Lagos' }],
    quote: async () => ({ ok: true, placeId: 'PQ', address: 'Ikeja, Lagos', distanceKm: 4.2, fee: 1200 }),
    cleanPhone: (t) => { const d = String(t).replace(/\D/g, ''); return /^0\d{10}$/.test(d) ? '234' + d.slice(1) : /^\d{12,13}$/.test(d) ? d : null; },
    menuIndex: async () => [MEALS.m1, MEALS.m2],
    savedDetails: async () => null,
    trackOrders: async () => ({ orders: [] }),
    createOrder: async (a) => { created.push(a); return { ok: true, orderId: 'o1', reference: 'ORD-1', total: 5000, paymentUrl: 'https://pay.test/x' }; },
    ...over,
  };
}
// Runs a conversation: each step is a message; state is carried forward the way the persistence layer does it.
async function run(steps, d = deps(), mode = 'full', conv = {}) {
  let c = { conversationState: 'greeting', currentCart: [], cartVersion: 0, customerPhone: '2348012345678', ...conv }; const outs = [];
  for (const s of steps) {
    const msg = typeof s === 'string' ? { type: 'text', text: s, buttonId: null } : { type: 'interactive', text: '', buttonId: s.id, ...s };
    const r = await handleInbound({ conv: c, msg, mode, deps: d });
    const { __handover, ...p } = r.patch; c = { ...c, ...p }; outs.push(r);
  }
  return { c, outs, last: outs.at(-1), d };
}
export { run, deps };
const bodyOf = (b) => b.preview;

test('addToCart merges identical lines', () => {
  const c = addToCart(addToCart([], { mealId: 'a', addonIds: ['x', 'y'], quantity: 1 }), { mealId: 'a', addonIds: ['y', 'x'], quantity: 2 });
  assert.equal(c.length, 1); assert.equal(c[0].quantity, 3);
});
test('greeting then menu then full order to payment link', async () => {
  const { c, last, d } = await run(['hi', { id: 'menu' }, { id: 'cat:c1' }, { id: 'item:m1' }, { id: 'size:s1' }, { id: 'addon:a1' }, { id: 'qty:2' }, { id: 'checkout' }, { id: 'fulfil:pickup' }, 'Ada Obi', { id: 'phone_yes' }, { id: 'confirm' }]);
  assert.equal(d.created.length, 1);
  assert.equal(d.created[0].method, 'online');
  assert.equal(d.created[0].conv.fulfillment, 'pickup');
  assert.equal(d.created[0].conv.currentCart[0].quantity, 2);
  assert.equal(c.conversationState, 'payment_pending');
  assert.equal(c.currentCart.length, 0);
  assert.ok(bodyOf(last.out[0]).includes('https://pay.test/x'));
});
test('a double tap on Confirm does not create a second order', async () => {
  const d = deps();
  const r = await run(['hi', { id: 'cat:c1' }, { id: 'item:m2' }, { id: 'qty:1' }, { id: 'checkout' }, { id: 'fulfil:pickup' }, 'Ada Obi', { id: 'phone_yes' }, { id: 'confirm' }], d);
  // replay the same confirm against the state BEFORE the cart was cleared: the lock must stop it
  const before = { ...r.c, currentCart: [{ mealId: 'm2', quantity: 1, addonIds: [] }], cartVersion: r.c.orderLock, fulfillment: 'pickup', customerPhone: '2348012345678', confirmedName: 'Ada Obi', phoneConfirmed: true };
  const again = await handleInbound({ conv: before, msg: { type: 'interactive', buttonId: 'confirm', text: '' }, mode: 'full', deps: d });
  assert.equal(d.created.length, 1);
  assert.ok(bodyOf(again.out[0]).includes('already placed'));
});
test('delivery: location, fee shown, outside radius', async () => {
  const r = await run(['hi', { id: 'cat:c1' }, { id: 'item:m2' }, { id: 'qty:1' }, { id: 'checkout' }, { id: 'fulfil:delivery' }, 'Ada Obi', { id: 'phone_yes' }, { type: 'location', buttonId: null, location: { lat: 6.5, lng: 3.3 } }]);
  assert.ok(bodyOf(r.last.out[0]).includes('₦1,200'));
  assert.equal(r.c.delivery.fee, 1200);
  const far = await run(['hi', { id: 'cat:c1' }, { id: 'item:m2' }, { id: 'qty:1' }, { id: 'checkout' }, { id: 'fulfil:delivery' }, 'Ada Obi', { id: 'phone_yes' }, { type: 'location', buttonId: null, location: { lat: 1, lng: 1 } }], deps({ quote: async () => ({ ok: false, maxRadiusKm: 15 }) }));
  assert.ok(bodyOf(far.last.out[0]).includes('outside our delivery range'));
});
test('typed address goes through suggestions', async () => {
  const r = await run(['hi', { id: 'cat:c1' }, { id: 'item:m2' }, { id: 'qty:1' }, { id: 'checkout' }, { id: 'fulfil:delivery' }, 'Ada Obi', { id: 'phone_yes' }, 'ikeja', { id: 'addr:0' }]);
  assert.equal(r.c.conversationState, 'delivery_confirmation');
});
test('human request and repeated confusion lead to handover', async () => {
  const r = await handleInbound({ conv: { conversationState: 'menu_browsing', greeted: true }, msg: { type: 'text', text: 'I want to speak to a manager' }, mode: 'full', deps: deps() });
  assert.ok(r.handover);
  let c = { conversationState: 'menu_browsing', greeted: true, failedAttempts: 0 }; let h = null;
  for (let i = 0; i < 3; i++) { const x = await handleInbound({ conv: c, msg: { type: 'text', text: 'blah blah' }, mode: 'full', deps: deps() }); c = { ...c, ...x.patch }; h = x.handover; }
  assert.ok(h);
});
test('info_only mode never starts an order and shows the online link', async () => {
  const r = await run(['hi', { id: 'checkout' }], deps(), 'info_only');
  for (const o of r.outs) { assert.equal(o.out.length, 1); assert.ok(bodyOf(o.out[0]).includes('https://x.test/r/mama')); }
});
test('closed restaurant: no ordering over WhatsApp', async () => {
  const d = deps({ restaurant: async () => ({ name: 'M', isOpen: false, menuUrl: 'https://x.test', settings: { outOfHoursMessage: 'Closed now' } }) });
  const r = await run([{ id: 'menu' }], d);
  assert.ok(bodyOf(r.last.out[0]).includes('Closed now'));
});
test('orders switched off mid-conversation: checkout refused', async () => {
  const r = await run(['hi', { id: 'cat:c1' }, { id: 'item:m2' }, { id: 'qty:1' }, { id: 'checkout' }], deps({ canOrder: async () => false }));
  assert.ok(bodyOf(r.last.out[0]).includes('not taking WhatsApp orders'));
});
test('bsuid customer is asked for a phone number; bad phone rejected', async () => {
  const r = await run(['hi', { id: 'cat:c1' }, { id: 'item:m2' }, { id: 'qty:1' }, { id: 'checkout' }, { id: 'fulfil:pickup' }, 'Ada Obi', 'abc'], deps(), 'full', { customerPhone: undefined });
  assert.equal(r.c.conversationState, 'phone_collection'); // name was taken, a bad phone is rejected and asked again
});
test('website cart session continues in WhatsApp', async () => {
  const d = deps({ claimSession: async (t) => (t === 'ORD-ABCDEF12' ? { items: [{ mealId: 'm2', quantity: 2, addonIds: [] }] } : null) });
  const r = await run(['Hi, continue my order ORD-ABCDEF12'], d);
  assert.equal(r.c.currentCart[0].mealId, 'm2');
});
test('removed items disappear from the cart', async () => {
  const r = await run(['hi', { id: 'cat:c1' }, { id: 'item:m2' }, { id: 'qty:1' }], deps(), 'full', {});
  const gone = await handleInbound({ conv: r.c, msg: { type: 'text', text: 'cart' }, mode: 'full', deps: deps({ price: async () => ({ items: [], unavailable: ['m2'], subtotal: 0 }) }) });
  assert.equal(gone.patch.currentCart.length, 0);
});
