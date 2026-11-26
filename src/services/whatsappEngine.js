// The WhatsApp ordering conversation. One function in, replies and changes out. It touches NO database and NO network by itself:
// everything it needs (menu, prices, delivery quote, order creation) comes in through `deps`, so the whole flow is unit-tested with fakes.
// Money is never worked out here: prices, delivery fees and orders all come from the same server code the website checkout uses.
import * as W from './whatsappPayloads.js';
import { readMessage, parseQuantity, searchMenuItems, DEFAULT_THRESHOLD } from './whatsappReader.js';
import { validName, displayPhone } from './whatsappCustomer.js';

const money = (n) => '₦' + Number(n || 0).toLocaleString('en-NG');
const PAGE = 8;                       // rows per page, leaving room for "More" and "Back" inside Meta's 10-row list limit
const MAX_FAILS = 3;
const FREE_TEXT_STATES = new Set(['name_collection', 'phone_collection', 'location_collection', 'delivery_details']); // states where typed text is DATA (a name, a number, an address), not a command
const STRICT_HUMAN = /^(human|agent|talk to (a |the )?(person|someone|human|staff)|speak (to|with) (a |the )?(person|someone|human|staff|restaurant)|i want a human)\b/i;
const FALLBACK = "Sorry, I didn't quite understand that. You can type MENU to browse our meals, CART to view your order, or HUMAN to speak with our team.";
const HUMAN_WORDS = /\b(human|agent|person|staff|manager|operator|representative|someone|speak to|talk to|call me|complain|complaint|refund)\b/i;
const sameLine = (a, b) => a.mealId === b.mealId && (a.sizeId || '') === (b.sizeId || '') && [...(a.addonIds || [])].sort().join() === [...(b.addonIds || [])].sort().join();

export function addToCart(cart, line) {
  const next = cart.map((l) => ({ ...l, addonIds: [...(l.addonIds || [])] }));
  const hit = next.find((l) => sameLine(l, line));
  if (hit) hit.quantity = Math.min(50, hit.quantity + line.quantity); else next.push({ ...line, addonIds: [...(line.addonIds || [])] });
  return next.slice(0, 60);
}

/** Commands a customer can type (or tap) at any time. */
function commandOf(msg) {
  const id = msg.buttonId;
  if (id && /^[a-z_]+$/.test(id)) return id;
  const t = (msg.text || '').trim().toLowerCase().replace(/[^a-z ]/g, '');
  if (['menu', 'order', 'start', 'restart', 'hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening'].includes(t)) return t === 'menu' || t === 'order' ? 'menu' : 'start';
  if (['cart', 'basket', 'my cart'].includes(t)) return 'cart';
  if (['cancel', 'stop', 'clear'].includes(t)) return 'cancel';
  if (['help', 'options'].includes(t)) return 'help';
  if (['track', 'status', 'my order', 'track order'].includes(t)) return 'track';
  return null;
}

export async function handleInbound({ conv, msg, mode, deps, now = new Date() }) {
  const out = [], patch = {};
  const say = (b) => out.push(b);
  const set = (o) => Object.assign(patch, o);
  const cur = () => ({ ...conv, ...patch });
  const rest = await deps.restaurant();
  const cfg = rest.settings || {};
  const done = () => ({ out, patch, handover: patch.__handover || null });
  const handover = (reason) => { patch.__handover = reason; };
  const ok = () => set({ failedAttempts: 0 });
  const homeButtons = () => W.buttons(`What would you like to do?`, [{ id: 'menu', title: 'View menu' }, { id: 'cart', title: 'My cart' }, { id: 'human', title: 'Talk to staff' }]);
  const linkMsg = (text) => W.ctaUrl(text, 'Order online', rest.menuUrl);

  const text = (msg.text || '').trim();
  if (msg.type === 'unsupported' || ['image', 'audio', 'video', 'document', 'sticker', 'contacts', 'reaction', 'order'].includes(msg.type)) {
    if (msg.type === 'reaction') return done();
    say(W.text('Sorry, I can only read text, buttons and shared locations. You can type MENU to see our menu or HUMAN to talk to our team.'));
    return countFail();
  }
  function countFail() {
    const n = (cur().failedAttempts || 0) + 1;
    if (n >= MAX_FAILS && cfg.handoverEnabled !== false) { set({ failedAttempts: 0 }); handover('The customer was not understood three times in a row.'); } else set({ failedAttempts: n });
    return done();
  }

  const cmd = commandOf(msg);

  // ---- a person asked for a person ----
  const collecting = FREE_TEXT_STATES.has(conv.conversationState);
  if (cmd === 'human' || (msg.type === 'text' && (collecting ? STRICT_HUMAN.test(text) : HUMAN_WORDS.test(text)) && !/^\d+$/.test(text))) {
    if (cfg.handoverEnabled === false) { say(W.text(`${rest.name} will reply when they can. Meanwhile you can type MENU to order.`)); return done(); }
    handover('The customer asked to speak to a person.'); return done();
  }

  // ---- info-only mode: orders are switched off, so only information and the online ordering link ----
  if (mode === 'info_only') {
    const hours = rest.isOpen ? 'We are open now.' : (cfg.outOfHoursMessage || 'We are closed right now.');
    say(linkMsg(`${cfg.welcomeMessage || `Hello from ${rest.name}!`}\n${cfg.businessDescription || ''}\n${hours}\nOrders are not taken on WhatsApp at the moment. You can order on our website:`.replace(/\n\n/g, '\n')));
    return done();
  }

  // ---- closed ----
  if (!rest.isOpen && !['cart', 'help', 'track'].includes(cmd)) {
    say(linkMsg(cfg.outOfHoursMessage || `${rest.name} is closed right now, so we cannot take orders on WhatsApp. You can browse and order ahead on our website:`));
    return done();
  }

  // ---- website cart handed to WhatsApp ("Continue on WhatsApp": message starts with ORD-XXXXXXXX) ----
  const sess = /\bORD-[A-F0-9]{8,}\b/i.exec(text)?.[0];
  if (sess && deps.claimSession) {
    const s = await deps.claimSession(sess.toUpperCase());
    if (s?.items?.length) { set({ currentCart: s.items, cartVersion: (cur().cartVersion || 0) + 1, conversationState: 'cart_management', flow: {}, ...(s.branchId ? { branchId: s.branchId } : {}) }); ok(); say(W.text('Welcome back! I have your cart from the website.')); return showCart(); }
  }

  switch (cmd) {
    case 'start': return greet(true);
    case 'menu': return showCategories(0);
    case 'cart': return showCart();
    case 'help': say(W.text('You can tap the buttons, or type: MENU to browse, CART to see your cart, TRACK for your order status, CANCEL to clear your cart, HUMAN to talk to our team.')); say(homeButtons()); return done();
    case 'track': return track();
    case 'cancel': set({ currentCart: [], cartVersion: (cur().cartVersion || 0) + 1, conversationState: 'greeting', flow: {} }); say(W.text('Your cart is cleared.')); say(homeButtons()); return done();
    default: break;
  }

  const id = msg.buttonId || '';
  const state = cur().conversationState || 'greeting';
  const flow = { ...(cur().flow || {}) };

  // ---- taps that carry data ----
  if (id.startsWith('more:')) { const [, kind, n, c] = id.split(':'); return kind === 'cat' ? showCategories(Number(n) || 0) : showItems(c, Number(n) || 0); }
  if (id.startsWith('cat:')) return showItems(id.slice(4), 0);
  if (id.startsWith('item:')) return pickItem(id.slice(5));
  if (id.startsWith('size:')) { flow.sizeId = id.slice(5); return afterSize(flow); }
  if (id.startsWith('addon:')) return pickAddon(flow, id.slice(6));
  if (id.startsWith('track:')) return track(id.slice(6));
  if (id.startsWith('qty:')) return addLine(flow, Number(id.slice(4)));
  if (id.startsWith('rm:')) return removeLine(Number(id.slice(3)));
  if (id === 'editcart') return editCart();
  if (id === 'checkout') return startCheckout();
  if (id === 'clear') return handleClear();
  if (id.startsWith('fulfil:')) return chooseFulfilment(id.slice(7));
  if (id.startsWith('addr:')) return chooseAddress(flow, Number(id.slice(5)));
  if (id === 'addr_yes') return confirmAddress(flow);
  if (id === 'addr_no') { set({ conversationState: 'location_collection', delivery: undefined, flow: {} }); return askLocation(); }
  if (id === 'confirm') return confirmOrder();
  if (id === 'name_yes') return nameYes();
  if (id === 'name_no') { set({ conversationState: 'name_collection' }); say(W.text('No problem. What is your full name?')); return done(); }
  if (id === 'phone_yes') return phoneYes();
  if (id === 'phone_other') { set({ conversationState: 'phone_collection' }); say(W.text('What phone number should we use? (e.g. 08012345678)')); return done(); }
  if (id === 'saved_addr_yes') return useSavedAddress();
  if (id === 'saved_addr_no') { set({ conversationState: 'location_collection', flow: {}, savedOffered: true }); return askLocation(); }
  if (id === 'details') return changeDetails();
  if (id === 'ai_yes') return applyPending(flow);
  if (id === 'ai_no') { set({ flow: {} }); say(W.text('Okay, nothing was changed.')); say(homeButtons()); return done(); }
  if (id.startsWith('pay:')) return pay(id.slice(4));

  // ---- free text, by state ----
  if (state === 'quantity') { const q = parseQuantity(text); if (q) return addLine(flow, q); }
  if (state === 'name_collection') return takeName(text);
  if (state === 'phone_collection') return takePhone(text);
  if (state === 'location_collection' || state === 'delivery_details') {
    if (msg.location) return takeLocation(msg.location);
    if (state === 'delivery_details' && text.length >= 5) return takeDetails(flow, text);
    if (state === 'delivery_details') { say(W.text('Please add a bit more detail (house number or name, and a landmark).')); return countFail(); }
    if (text.length >= 3) return searchAddress(text);
  }
  if (msg.type === 'location') { say(W.text('Thanks! I need your delivery location only when you check out. Type MENU to start an order.')); return done(); }

  // The deterministic reader first, with no AI. Confident results run straight away.
  const menu = await deps.menuIndex();
  const read = readMessage({ text, state, menu, cartLines: (cur().currentCart || []).length });
  const threshold = deps.threshold ?? DEFAULT_THRESHOLD;
  if (read.confidence >= threshold) return act(read, flow, false);

  // Not confident. Try a plain menu search ("add one rice" -> the rice dishes), still without AI.
  const found = searchMenuItems(text, menu);
  if (found.length && read.intent !== 'PRICE_QUERY') return offerChoices(found, 'Which of these would you like?');

  // Only now, and only if this restaurant has AI on and the provider is available, ask the AI to interpret (it only proposes; act() re-checks everything).
  if (deps.ai && text.length >= 3 && text.length <= 500 && msg.type === 'text') {
    const r = await deps.ai({ text, state, menu });
    if (r?.ok) return act(r.interpretation, flow, true);
  }
  if (state === 'greeting' || !cur().greeted) return greet(false);
  say(W.text(FALLBACK)); say(homeButtons());
  return countFail();

  /* ===== reader / AI dispatcher: the ONE place an interpretation becomes an action ===== */
  async function act(it, f, fromAi) {
    const e = it.entities || {}; const c = cur();
    switch (it.intent) {
      case 'GREETING': return greet(true);
      case 'SHOW_MENU': return showCategories(0);
      case 'SHOW_CART': return showCart();
      case 'CHECKOUT': return startCheckout();
      case 'HUMAN': if (cfg.handoverEnabled === false) { say(W.text(`${rest.name} will reply when they can.`)); return done(); } handover('The customer asked to speak to a person.'); return done();
      case 'TRACK_ORDER': return track(e.reference);
      case 'CLEAR_CART': case 'CANCEL': return handleClear();
      case 'HELP': say(W.text('You can tap the buttons, or type: MENU, CART, TRACK for your order status, CANCEL to clear your cart, HUMAN to talk to our team.')); say(homeButtons()); return done();
      case 'SET_FULFILMENT':
        if (!(c.currentCart || []).length) { say(W.text('Your cart is empty. Type MENU to choose your meals first.')); return done(); }
        return chooseFulfilment(e.fulfilment);
      case 'YES': case 'NO': return yesNo(it.intent === 'YES');
      case 'INCREMENT_LAST': case 'SET_QUANTITY_LAST': return changeLast(it.intent === 'INCREMENT_LAST' ? { by: e.by || 1 } : { to: e.quantity });
      case 'PRICE_QUERY': return priceOf(e.items || []);
      case 'ADD_ITEMS': case 'REMOVE_ITEM': {
        if (it.intent === 'REMOVE_ITEM' && !fromAi) return removeItems(e);
        if (fromAi) { // an AI-proposed change to the cart is only applied after the customer says yes
          const lines = (e.items || []);
          if (!lines.length) { say(W.text(FALLBACK)); return countFail(); }
          set({ flow: { pending: { type: it.intent, items: lines, last: !!e.last } } });
          say(W.buttons(`${it.intent === 'ADD_ITEMS' ? 'Add' : 'Remove'} ${lines.map((l) => `${l.quantity} x ${l.name}`).join(', ')}${it.intent === 'ADD_ITEMS' ? ' to your cart' : ' from your cart'}?`, [{ id: 'ai_yes', title: 'Yes' }, { id: 'ai_no', title: 'No' }]));
          return done();
        }
        return addItems(e.items || []);
      }
      case 'SEARCH_MENU': {
        const s2 = e.search || {}; const list = searchMenuItems((s2.keywords || []).join(' '), menu, { cheap: s2.cheap, limit: 6 });
        return list.length ? offerChoices(list, 'Here is what we have. Which would you prefer?') : (say(W.text("I couldn't find something like that. Type MENU to see everything we have.")), done());
      }
      case 'REORDER_LAST': return reorder();
      case 'RESTAURANT_INFO': return info();
      case 'CLARIFY': if (it.clarification) { say(W.text(it.clarification)); say(homeButtons()); return done(); } say(W.text(FALLBACK)); return countFail();
      default: say(W.text(FALLBACK)); say(homeButtons()); return countFail();
    }
  }

  /* ===== steps ===== */
  function greet(restart) {
    const first = !cur().greeted;
    set({ greeted: true, conversationState: 'menu_browsing', flow: {}, failedAttempts: 0 });
    if (restart && cur().currentCart?.length) say(W.text('Welcome back! Your cart is still saved.'));
    say(W.text(`${cfg.welcomeMessage || `Hello! Welcome to ${rest.name}.`}${first && cfg.businessDescription ? `\n\n${cfg.businessDescription}` : ''}`));
    say(homeButtons());
    return done();
  }

  async function showCategories(page) {
    const cats = await deps.categories();
    if (!cats.length) { say(W.text('Our menu is not ready yet. Please check back soon.')); return done(); }
    set({ conversationState: 'menu_browsing', flow: {} }); ok();
    const slice = cats.slice(page * PAGE, page * PAGE + PAGE);
    const rows = slice.map((c) => ({ id: `cat:${c.id}`, title: c.name, description: `${c.count} item${c.count === 1 ? '' : 's'}` }));
    if (cats.length > (page + 1) * PAGE) rows.push({ id: `more:cat:${page + 1}`, title: 'More categories' });
    say(W.list('Pick a category:', 'Categories', rows, 'Menu'));
    return done();
  }

  async function showItems(catId, page) {
    const items = await deps.items(catId);
    if (!items.length) { say(W.text('That category has nothing available right now.')); return showCategories(0); }
    set({ conversationState: 'product_selection', flow: { catId } }); ok();
    const slice = items.slice(page * PAGE, page * PAGE + PAGE);
    const rows = slice.map((m) => ({ id: `item:${m.id}`, title: m.name, description: `${m.sizes?.length ? 'from ' : ''}${money(m.price)}${m.description ? ' · ' + m.description : ''}` }));
    if (items.length > (page + 1) * PAGE) rows.push({ id: `more:item:${page + 1}:${catId}`, title: 'More items' });
    say(W.list('Choose an item:', 'Items', rows, 'Items'));
    return done();
  }

  async function pickItem(mealId, qty = null, queue = []) {
    const m = await deps.meal(mealId);
    if (!m) { say(W.text('Sorry, that item is no longer available.')); return showCategories(0); }
    const f = { mealId, sizeId: null, addonIds: [], addonsDone: false, catId: flow.catId, qty, queue };
    set({ conversationState: 'product_selection', flow: f }); ok();
    if (m.sizes?.length) {
      say(W.list(`${m.name}: choose a size`, 'Sizes', m.sizes.slice(0, 10).map((s) => ({ id: `size:${s.id}`, title: s.name, description: money(s.price) })), 'Sizes'));
      return done();
    }
    return afterSize(f);
  }

  async function afterSize(f) {
    const m = await deps.meal(f.mealId);
    if (!m) return showCategories(0);
    if (f.sizeId && !m.sizes?.some((s) => s.id === f.sizeId)) { say(W.text('That size is not available.')); return showCategories(0); }
    set({ flow: f });
    if (m.addons?.length && !f.addonsDone) return askAddons(m, f);
    return askQty(m, f);
  }

  function askAddons(m, f) {
    const chosen = new Set(f.addonIds || []);
    const rows = m.addons.filter((a) => !chosen.has(a.id)).slice(0, 8).map((a) => ({ id: `addon:${a.id}`, title: a.name, description: `+${money(a.price)}` }));
    rows.push({ id: 'addon:done', title: chosen.size ? 'Done, no more extras' : 'No extras' });
    say(W.list(`${m.name}: any extras?${chosen.size ? `\nAdded: ${m.addons.filter((a) => chosen.has(a.id)).map((a) => a.name).join(', ')}` : ''}`, 'Extras', rows, 'Extras'));
    return done();
  }

  async function pickAddon(f, addonId) {
    const m = await deps.meal(f.mealId);
    if (!m) return showCategories(0);
    if (addonId === 'done') f.addonsDone = true;
    else if (m.addons?.some((a) => a.id === addonId)) f.addonIds = [...new Set([...(f.addonIds || []), addonId])];
    else { say(W.text('That extra is not available.')); return askAddons(m, f); }
    set({ flow: f });
    if (!f.addonsDone && f.addonIds.length < m.addons.length) return askAddons(m, f);
    f.addonsDone = true; set({ flow: f });
    return askQty(m, f);
  }

  function askQty(m, f) {
    if (f.qty) return addLine(f, f.qty); // the customer already said how many ("two burgers")
    set({ conversationState: 'quantity', flow: f });
    say(W.buttons(`How many ${m.name}?\n(Tap a number, or type one.)`, [{ id: 'qty:1', title: '1' }, { id: 'qty:2', title: '2' }, { id: 'qty:3', title: '3' }]));
    return done();
  }

  async function addLine(f, qty) {
    if (!f.mealId || !(qty >= 1 && qty <= 50)) { say(W.text('Please choose an item first.')); return showCategories(0); }
    const cart = addToCart(cur().currentCart || [], { mealId: f.mealId, sizeId: f.sizeId || undefined, addonIds: f.addonIds || [], quantity: qty });
    set({ currentCart: cart, cartVersion: (cur().cartVersion || 0) + 1, conversationState: 'cart_management', flow: {} }); ok();
    const queue = f.queue || [];
    if (queue.length) { say(W.text('Added to your cart ✅')); return pickItem(queue[0].mealId, queue[0].quantity, queue.slice(1)); }
    say(W.text('Added to your cart ✅'));
    return showCart();
  }

  /* ----- natural-language helpers (used by the reader and, after validation, the AI) ----- */
  async function addItems(items) {
    const simple = [], complex = [], gone = [];
    for (const it of items) { const m = await deps.meal(it.mealId); if (!m) gone.push(it.name); else if (m.sizes?.length || m.addons?.length) complex.push(it); else simple.push(it); }
    let cart = cur().currentCart || [];
    for (const it of simple) cart = addToCart(cart, { mealId: it.mealId, addonIds: [], quantity: it.quantity || 1 });
    if (simple.length) set({ currentCart: cart, cartVersion: (cur().cartVersion || 0) + 1, conversationState: 'cart_management', flow: {} });
    ok();
    if (gone.length) say(W.text(`Sorry, ${gone.join(', ')} ${gone.length === 1 ? 'is' : 'are'} not available right now.`));
    if (simple.length) say(W.text(`Added: ${simple.map((i) => `${i.quantity || 1} x ${i.name}`).join(', ')} ✅`));
    if (complex.length) return pickItem(complex[0].mealId, complex[0].quantity || 1, complex.slice(1));
    return simple.length ? showCart() : (say(homeButtons()), done());
  }
  function removeItems(e) {
    let cart = [...(cur().currentCart || [])];
    if (!cart.length) { say(W.text('Your cart is empty.')); return done(); }
    if (e.last || !(e.items || []).length) cart.pop(); else { const ids = new Set(e.items.map((i) => i.mealId)); cart = cart.filter((l) => !ids.has(l.mealId)); }
    set({ currentCart: cart, cartVersion: (cur().cartVersion || 0) + 1 }); ok();
    say(W.text('Removed ✅'));
    return showCart();
  }
  function changeLast({ by, to }) {
    const cart = [...(cur().currentCart || [])];
    if (!cart.length) { say(W.text('Your cart is empty. Type MENU to start.')); return done(); }
    const last = { ...cart[cart.length - 1] };
    last.quantity = Math.min(50, Math.max(1, to != null ? to : last.quantity + (by || 1)));
    cart[cart.length - 1] = last;
    set({ currentCart: cart, cartVersion: (cur().cartVersion || 0) + 1 }); ok();
    return showCart();
  }
  async function priceOf(items) {
    const menu = await deps.menuIndex(); const lines = [];
    for (const it of items) { const m = menu.find((x) => String(x.id) === String(it.mealId)); if (!m) continue; lines.push(m.sizes?.length ? `${m.name}: ${m.sizes.map((s) => `${s.name} ${money(s.price)}`).join(', ')}` : `${m.name}: ${money(m.price)}`); }
    if (!lines.length) { say(W.text("I couldn't find that on our menu. Type MENU to see everything we have.")); return done(); }
    ok(); say(W.text(lines.join('\n'))); say(homeButtons()); return done();
  }
  function offerChoices(list, header) {
    ok(); set({ conversationState: 'product_selection', flow: {} });
    say(W.list(header, 'Choices', list.slice(0, 8).map((m) => ({ id: `item:${m.id}`, title: m.name, description: money(m.price) })), 'Matches'));
    return done();
  }
  async function applyPending(f) {
    const p = f.pending; set({ flow: {} });
    if (!p) return showCart();
    if (p.type === 'ADD_ITEMS') return addItems(p.items);
    if (p.type === 'REMOVE_ITEM') return removeItems({ items: p.items, last: p.last });
    if (p.type === 'REORDER') { let cart = cur().currentCart || []; for (const l of p.lines) cart = addToCart(cart, l); set({ currentCart: cart, cartVersion: (cur().cartVersion || 0) + 1, conversationState: 'cart_management' }); say(W.text('Added ✅')); return showCart(); }
    return showCart();
  }
  async function reorder() {
    const lines = deps.lastOrderLines ? await deps.lastOrderLines() : [];
    if (!lines.length) { say(W.text("I can't find an earlier order for you. Type MENU to start a new one.")); return done(); }
    const p = await deps.price(lines); const gone = new Set(p.unavailable || []);
    const ok2 = lines.filter((l) => !gone.has(l.mealId));
    if (!ok2.length) { say(W.text('None of the items from your last order are available right now. Type MENU to see what we have.')); return done(); }
    const pp = await deps.price(ok2);
    set({ flow: { pending: { type: 'REORDER', lines: ok2 } } });
    say(W.buttons(`Your last order${gone.size ? ' (some items are no longer available and were left out)' : ''}:\n${pp.items.map((i) => `${i.quantity} x ${i.name}`).join('\n')}\nAdd these to your cart?`.slice(0, 1000), [{ id: 'ai_yes', title: 'Yes, add' }, { id: 'ai_no', title: 'No' }]));
    return done();
  }
  async function info() {
    const o = await deps.fulfilmentOptions();
    say(W.text(`${rest.name} is ${rest.isOpen ? 'open now' : 'closed right now'}.\n${o.delivery ? 'Delivery is available. ' : ''}${o.pickup ? 'Pickup is available.' : ''}\nType MENU to see our meals and prices.`.trim()));
    return done();
  }
  function yesNo(yes) {
    const st = cur().conversationState;
    if (st === 'name_confirmation') return yes ? nameYes() : (set({ conversationState: 'name_collection' }), say(W.text('No problem. What is your full name?')), done());
    if (st === 'phone_confirmation') return yes ? phoneYes() : (set({ conversationState: 'phone_collection' }), say(W.text('What phone number should we use? (e.g. 08012345678)')), done());
    if (st === 'delivery_confirmation') return yes ? confirmAddress() : (set({ conversationState: 'location_collection', delivery: undefined, flow: {} }), askLocation());
    if (st === 'saved_address') return yes ? useSavedAddress() : (set({ conversationState: 'location_collection', flow: {}, savedOffered: true }), askLocation());
    if (st === 'checkout_summary') return yes ? confirmOrder() : changeDetails();
    say(W.text(FALLBACK)); say(homeButtons()); return countFail();
  }

  async function showCart() {
    const cart = cur().currentCart || [];
    if (!cart.length) { set({ conversationState: 'menu_browsing' }); say(W.text('Your cart is empty.')); say(W.buttons('Start an order?', [{ id: 'menu', title: 'View menu' }, { id: 'human', title: 'Talk to staff' }])); return done(); }
    const p = await deps.price(cart);
    if (p.unavailable?.length) {
      const gone = new Set(p.unavailable);
      set({ currentCart: cart.filter((l) => !gone.has(l.mealId)), cartVersion: (cur().cartVersion || 0) + 1 });
      say(W.text('Some items in your cart are no longer available and were removed.'));
      if (p.unavailable.length === new Set(cart.map((l) => l.mealId)).size) return showCart();
      return showCart();
    }
    set({ conversationState: 'cart_management' });
    const lines = p.items.map((i, n) => `${n + 1}. ${i.quantity} x ${i.name}${i.size ? ` (${i.size})` : ''}${i.addons?.length ? ` + ${i.addons.map((a) => a.name).join(', ')}` : ''} — ${money(i.price * i.quantity)}`);
    say(W.buttons(`🛒 Your cart\n${lines.join('\n')}\n\nSubtotal: ${money(p.subtotal)}`.slice(0, 1000), [{ id: 'checkout', title: 'Checkout' }, { id: 'menu', title: 'Add more' }, { id: 'editcart', title: 'Edit cart' }]));
    return done();
  }

  async function editCart() {
    const cart = cur().currentCart || [];
    if (!cart.length) return showCart();
    const p = await deps.price(cart);
    const rows = p.items.slice(0, 9).map((i, n) => ({ id: `rm:${n}`, title: `Remove ${i.name}`, description: `${i.quantity} x ${money(i.price)}` }));
    rows.push({ id: 'clear', title: 'Clear whole cart' });
    say(W.list('Which item would you like to remove?', 'Edit cart', rows, 'Cart'));
    return done();
  }
  function removeLine(n) {
    const cart = [...(cur().currentCart || [])];
    if (n >= 0 && n < cart.length) { cart.splice(n, 1); set({ currentCart: cart, cartVersion: (cur().cartVersion || 0) + 1 }); }
    return showCart();
  }
  function handleClear() {
    set({ currentCart: [], cartVersion: (cur().cartVersion || 0) + 1, conversationState: 'menu_browsing', flow: {} });
    say(W.text('Your cart is cleared.')); say(homeButtons()); return done();
  }

  async function startCheckout() {
    const cart = cur().currentCart || [];
    if (!cart.length) return showCart();
    if (!(await deps.canOrder())) { say(linkMsg('Sorry, we are not taking WhatsApp orders right now. You can order on our website:')); return done(); }
    const opts = await deps.fulfilmentOptions();
    if (!opts.delivery && !opts.pickup) { say(linkMsg('Sorry, we cannot take this order here. Please use our website:')); return done(); }
    set({ conversationState: 'fulfilment_selection' });
    if (opts.delivery && opts.pickup) say(W.buttons('How would you like to get your order?', [{ id: 'fulfil:delivery', title: 'Delivery' }, { id: 'fulfil:pickup', title: 'Pickup' }]));
    else return chooseFulfilment(opts.delivery ? 'delivery' : 'pickup');
    return done();
  }

  async function chooseFulfilment(kind) {
    const opts = await deps.fulfilmentOptions();
    if (!opts[kind]) { say(W.text(`Sorry, ${kind} is not available.`)); return startCheckout(); }
    set({ fulfillment: kind, delivery: undefined, savedOffered: false, flow: {} });
    return nextInfoStep();
  }

  /* ===== customer details: full name -> phone -> (delivery) address -> summary. Typed by the customer, never taken from the WhatsApp profile name. ===== */
  async function nextInfoStep() {
    const c = cur();
    if (!c.confirmedName) return askName();
    if (!c.phoneConfirmed) return askPhone();
    if (c.fulfillment === 'delivery' && !(c.delivery?.placeId && c.delivery?.details)) return askDelivery();
    return summary();
  }
  async function askName() {
    const saved = await deps.savedDetails();
    if (saved?.name) { set({ conversationState: 'name_confirmation' }); say(W.buttons(`Great! Before we complete your order: is your full name ${saved.name}?`, [{ id: 'name_yes', title: 'Yes' }, { id: 'name_no', title: 'No, change it' }])); return done(); }
    set({ conversationState: 'name_collection' });
    say(W.text('Great! Before we complete your order, what is your full name?'));
    return done();
  }
  async function nameYes() {
    const saved = await deps.savedDetails();
    if (!saved?.name) { set({ conversationState: 'name_collection' }); say(W.text('What is your full name?')); return done(); }
    set({ confirmedName: saved.name }); ok();
    return nextInfoStep();
  }
  function takeName(t) {
    const n = validName(t);
    if (!n) { say(W.text('Please type your full name, using letters only (for example: John Adebayo).')); return countFail(); }
    set({ confirmedName: n }); ok();
    say(W.text(`Thank you, ${n.split(' ')[0]}.`));
    return nextInfoStep();
  }
  function askPhone() {
    const wa = cur().customerPhone;
    if (wa) { set({ conversationState: 'phone_confirmation' }); say(W.buttons(`Your WhatsApp number is ${displayPhone(wa)}. Is this the best number to reach you?`, [{ id: 'phone_yes', title: 'Yes' }, { id: 'phone_other', title: 'Use another' }])); return done(); }
    set({ conversationState: 'phone_collection' });
    say(W.text('What phone number can the restaurant call about this order? (e.g. 08012345678)'));
    return done();
  }
  function phoneYes() {
    const wa = cur().customerPhone;
    if (!wa) return askPhone();
    set({ contactPhone: wa, phoneConfirmed: true }); ok();
    return nextInfoStep();
  }
  function takePhone(t) {
    const p = deps.cleanPhone(t);
    if (!p) { say(W.text('That does not look like a valid phone number. Please type it like 08012345678.')); return countFail(); }
    set({ contactPhone: p, phoneConfirmed: true }); ok();
    return nextInfoStep();
  }
  async function askDelivery() {
    const saved = !cur().savedOffered ? await deps.savedDetails() : null;
    if (saved?.address) {
      set({ conversationState: 'saved_address', savedOffered: true });
      say(W.buttons(`Should we deliver to your previous address?\n📍 ${saved.address}`.slice(0, 1000), [{ id: 'saved_addr_yes', title: 'Yes, same place' }, { id: 'saved_addr_no', title: 'New address' }]));
      return done();
    }
    set({ conversationState: 'location_collection' });
    return askLocation();
  }
  async function useSavedAddress() {
    const saved = await deps.savedDetails();
    if (!saved?.placeId) { set({ conversationState: 'location_collection' }); return askLocation(); }
    return quoteAndConfirm(saved.placeId); // the old address is re-quoted and the customer must confirm it again
  }
  function changeDetails() {
    set({ confirmedName: undefined, phoneConfirmed: false, contactPhone: undefined, delivery: undefined, savedOffered: false, flow: {} });
    say(W.text("Okay, let's update your details."));
    return nextInfoStep();
  }

  function askLocation() {
    say(W.locationRequest('Please share your delivery location, or type your address (street, area, city).'));
    return done();
  }

  async function takeLocation(loc) {
    const placeId = await deps.placeFromCoords(loc);
    return quoteAndConfirm(placeId);
  }
  async function searchAddress(q) {
    let list = [];
    try { list = await deps.searchAddress(q); } catch { say(W.text('Address search is not working right now. Please share your location using the button, or type MENU to order on our website.')); return done(); }
    if (!list.length) { say(W.text("I couldn't find that address. Try adding the area or city, or share your location.")); return countFail(); }
    set({ flow: { suggestions: list.slice(0, 5).map((s) => ({ placeId: s.placeId, text: s.text })) } });
    say(W.list('Pick your address:', 'Addresses', list.slice(0, 5).map((s, n) => ({ id: `addr:${n}`, title: s.main || s.text, description: s.secondary || s.text })), 'Matches'));
    return done();
  }
  function chooseAddress(f, n) {
    const s = f.suggestions?.[n];
    if (!s) { say(W.text('Please search for your address again.')); return askLocation(); }
    return quoteAndConfirm(s.placeId);
  }
  async function quoteAndConfirm(placeId) {
    let q;
    try { q = await deps.quote(placeId); } catch (e) { say(W.text(e.message && e.status < 500 ? e.message : 'We could not work out the delivery price right now. Please try again, or choose pickup.')); return done(); }
    if (!q.ok) {
      say(W.text(`Sorry, that address is outside our delivery range (${q.maxRadiusKm} km).`));
      const opts = await deps.fulfilmentOptions();
      if (opts.pickup) say(W.buttons('Would you like pickup instead?', [{ id: 'fulfil:pickup', title: 'Pickup' }, { id: 'addr_no', title: 'Other address' }]));
      return done();
    }
    set({ conversationState: 'delivery_confirmation', delivery: { placeId: q.placeId, address: q.address, distanceKm: q.distanceKm, fee: q.fee }, flow: {} });
    say(W.buttons(`📍 ${q.address}\nDistance: ${q.distanceKm} km\nDelivery fee: ${money(q.fee)}\n\nIs this right?`, [{ id: 'addr_yes', title: 'Yes, correct' }, { id: 'addr_no', title: 'Change address' }]));
    return done();
  }
  function confirmAddress() {
    if (!cur().delivery?.placeId) return askLocation();
    set({ conversationState: 'delivery_details', flow: {} });
    say(W.text('Please type your house number or name and a landmark, so the rider can find you. (For example: "No. 5, opposite the green gate")'));
    return done();
  }
  function takeDetails(f, t) {
    set({ delivery: { ...cur().delivery, details: t.slice(0, 200) } });
    return nextInfoStep();
  }

  async function summary() {
    const c = cur();
    const p = await deps.price(c.currentCart || []);
    if (p.unavailable?.length) { say(W.text('Some items are no longer available. Please check your cart.')); return showCart(); }
    const fee = c.fulfillment === 'delivery' ? c.delivery?.fee || 0 : 0;
    set({ conversationState: 'checkout_summary' });
    const lines = p.items.map((i) => `${i.quantity} x ${i.name}${i.size ? ` (${i.size})` : ''}`);
    const body = `🧾 Please check your order\n\nCustomer: ${c.confirmedName}\nPhone: ${displayPhone(c.contactPhone || c.customerPhone)}\nOrder: ${lines.join(', ')}\nOrder type: ${c.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}${c.fulfillment === 'delivery' ? `\nDelivery address: ${c.delivery?.address}${c.delivery?.details ? ` (${c.delivery.details})` : ''}` : ''}\nFood subtotal: ${money(p.subtotal)}${c.fulfillment === 'delivery' ? `\nDelivery fee: ${money(fee)}` : ''}\nTotal: ${money(p.subtotal + fee)}\n\nAre these details correct?`;
    say(W.buttons(body.slice(0, 1000), [{ id: 'confirm', title: 'Yes, confirm' }, { id: 'details', title: 'Change details' }, { id: 'cancel', title: 'Cancel' }]));
    return done();
  }

  async function confirmOrder() {
    const c = cur();
    if (!c.currentCart?.length) return showCart();
    if (!c.fulfillment) return startCheckout();
    // A payment link is never sent until every required detail has been collected and the customer has confirmed the summary.
    if (!c.confirmedName || !c.phoneConfirmed || (c.fulfillment === 'delivery' && !(c.delivery?.placeId && c.delivery?.details))) return nextInfoStep();
    const methods = await deps.paymentMethods(c.fulfillment);
    if (!methods.length) { say(linkMsg('Sorry, no payment method is available for WhatsApp orders. Please use our website:')); return done(); }
    if (methods.length === 1) return pay(methods[0]);
    set({ conversationState: 'payment_selection' });
    say(W.buttons('How would you like to pay?', methods.map((m) => ({ id: `pay:${m}`, title: m === 'online' ? 'Pay online' : 'Pay on delivery' }))));
    return done();
  }

  async function pay(method) {
    const c = cur();
    if (!c.currentCart?.length || !c.fulfillment) return showCart();
    if (!c.confirmedName || !c.phoneConfirmed) return nextInfoStep();
    if (c.orderLock === c.cartVersion && c.currentOrderId) { say(W.text('You already placed this order. Type TRACK to see its status.')); return done(); }
    const methods = await deps.paymentMethods(c.fulfillment);
    if (!methods.includes(method)) { say(W.text('That payment option is not available.')); return confirmOrder(); }
    const res = await deps.createOrder({ conv: c, method });
    if (!res.ok) { say(W.text(res.error || 'Sorry, we could not place your order. Please try again or type HUMAN.')); return done(); }
    set({ orderLock: c.cartVersion, currentOrderId: res.orderId, conversationState: res.paymentUrl ? 'payment_pending' : 'order_confirmed', currentCart: [], cartVersion: (c.cartVersion || 0) + 1, delivery: undefined, savedOffered: false, flow: {} });
    ok();
    if (res.paymentUrl) say(W.ctaUrl(`Order ${res.reference} created. Total: ${money(res.total)}.\nTap to pay securely. Your order is confirmed only after your payment is verified, and we will send your confirmation and tracking link here.`, 'Pay now', res.paymentUrl));
    else say(W.text(`✅ Order ${res.reference} placed! Total: ${money(res.total)} (pay on delivery).${res.trackingUrl ? `\n📍 Track your order: ${res.trackingUrl}` : ''}\nWe'll update you here as it moves along.`));
    return done();
  }

  async function track(reference) {
    const r = await deps.trackOrders(cur(), reference || null);
    if (!r.orders.length) { say(W.text(reference ? "I couldn't find an order with that reference on this number." : "I can't find an order yet. Type MENU to start one.")); return done(); }
    ok();
    if (r.orders.length > 1) { // several active orders: ask which one
      say(W.list('Which order would you like to track?', 'My orders', r.orders.slice(0, 8).map((o) => ({ id: `track:${o.reference}`, title: o.reference, description: o.statusText })), 'Orders'));
      return done();
    }
    const o = r.orders[0];
    say(W.text(`Order ${o.reference}: ${o.statusText}${o.link ? `\n📍 Track it here: ${o.link}` : ''}`));
    return done();
  }
}
