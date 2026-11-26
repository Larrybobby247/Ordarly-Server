import test from 'node:test';
import assert from 'node:assert/strict';
import { readMessage, parseQuantity, matchItems, normalize } from '../src/services/whatsappReader.js';

const MENU = [{ id: '1', name: 'Chicken and Chips' }, { id: '2', name: 'Burger' }, { id: '3', name: 'Jollof Rice' }, { id: '4', name: 'Fried Rice' }, { id: '5', name: 'Chicken' }];
const r = (text, state = 'greeting', cartLines = 0) => readMessage({ text, state, menu: MENU, cartLines });

test('greetings, menu and commands without any AI', () => {
  for (const t of ['Hi', 'Hello', 'Good morning', 'hey there']) assert.equal(r(t).intent, 'GREETING', t);
  for (const t of ['Menu', 'Show me your menu', 'Abeg show me your menu.', 'I want to order', 'I wan order food']) assert.equal(r(t).intent, 'SHOW_MENU', t);
  assert.equal(r("What's in my cart?").intent, 'SHOW_CART');
  assert.equal(r('Show my cart').intent, 'SHOW_CART');
  assert.equal(r('I want to checkout', 'cart_management', 2).intent, 'CHECKOUT');
  assert.equal(r('Where is my order?').intent, 'TRACK_ORDER');
  assert.equal(r('Track my order').intent, 'TRACK_ORDER');
  assert.equal(r('Track ORD-AB12CD34').entities.reference, 'ORD-AB12CD34');
  for (const t of ['Talk to someone', 'Speak with a human', 'I need assistance', 'Call me']) assert.equal(r(t).intent, 'HUMAN', t);
});
test('orders with quantities, Nigerian wording and plurals', () => {
  let x = r('I need two burgers'); assert.equal(x.intent, 'ADD_ITEMS'); assert.deepEqual([x.entities.items[0].mealId, x.entities.items[0].quantity], ['2', 2]);
  x = r('Add 2 chicken and chips'); assert.deepEqual(x.entities.items.map((i) => [i.mealId, i.quantity]), [['1', 2]]); // the longer name wins over "chicken"
  x = r('Add one rice'); assert.equal(x.entities.items?.length || 0, 0); // "rice" alone is ambiguous: the engine offers matching dishes
  x = r('I need two plates of jollof rice'); assert.deepEqual(x.entities.items.map((i) => [i.mealId, i.quantity]), [['3', 2]]);
  x = r('2 burgers and 1 fried rice'); assert.deepEqual(x.entities.items.map((i) => [i.mealId, i.quantity]), [['2', 2], ['4', 1]]);
  x = r('burga'); assert.equal(x.entities.items[0].mealId, '2');
});
test('price questions, removal, relative quantities', () => {
  assert.deepEqual(r('How much is your chicken?').entities.items.map((i) => i.mealId), ['5']);
  assert.equal(r('Remove the burger').intent, 'REMOVE_ITEM');
  assert.equal(r('No, remove that one').entities.last, true);
  assert.deepEqual([r('Make it three').intent, r('Make it three').entities.quantity], ['SET_QUANTITY_LAST', 3]);
  assert.equal(r('Add another one').intent, 'INCREMENT_LAST');
  assert.equal(r('Increase the quantity').intent, 'INCREMENT_LAST');
});
test('delivery and pickup wording', () => {
  assert.equal(r('I want delivery', 'fulfilment_selection').entities.fulfilment, 'delivery');
  assert.equal(r('I will pick it up', 'fulfilment_selection').entities.fulfilment, 'pickup');
  assert.equal(r('I want to collect it myself', 'fulfilment_selection').entities.fulfilment, 'pickup');
});
test('quantity only counts when asked for; bare numbers are not menu choices', () => {
  assert.equal(parseQuantity('Two'), 2); assert.equal(parseQuantity('3'), 3); assert.equal(parseQuantity('make it 4'), 4); assert.equal(parseQuantity('chicken'), null);
  assert.equal(r('2', 'menu_browsing').intent, 'UNKNOWN'); // the engine decides what a bare number means from its state
});
test('unclear requests are low confidence so the AI layer may be asked', () => {
  for (const t of ['Can I get something that is filling but not too expensive?', 'I want the same thing I ordered yesterday', 'blah']) assert.ok(r(t).confidence < 0.75, t);
});
test('no invented items: unknown dish matches nothing', () => {
  assert.equal(matchItems('I want two pizzas', MENU).length, 0);
  assert.equal(normalize('Abeg  PLEASE show me!!'), 'show me');
});
