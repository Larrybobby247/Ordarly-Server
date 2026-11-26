// The deterministic message reader: understands everyday restaurant messages with NO AI and NO network.
// Pure: text + conversation state + the menu in, a structured interpretation out. It is always tried first; the AI layer is only asked
// when this returns low confidence. It never changes anything itself; the conversation engine decides what to do with the result.

export const DEFAULT_THRESHOLD = 0.75;

// Spelling variations and Nigerian-English wording (administrators can extend this later through the `synonyms` argument).
export const DEFAULT_SYNONYMS = Object.freeze({
  burga: 'burger', burgar: 'burger', berger: 'burger', chiken: 'chicken', chicken: 'chicken', cheken: 'chicken', jolof: 'jollof', frid: 'fried', fride: 'fried',
  wan: 'want', wann: 'want', wnt: 'want', abeg: '', pls: '', plz: '', please: '', kindly: '', wetin: 'what', menus: 'menu', mnu: 'menu', meny: 'menu',
  fries: 'fries', checkout: 'checkout', chekout: 'checkout', deliver: 'delivery', delivary: 'delivery', pikup: 'pickup',
});
const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, dozen: 12, half: 1 };
const UNIT_WORDS = new Set(['plate', 'plates', 'portion', 'portions', 'pack', 'packs', 'piece', 'pieces', 'pcs', 'pc', 'bottle', 'bottles', 'wrap', 'wraps', 'order', 'orders', 'of']);
const STOP = new Set(['the', 'a', 'an', 'and', 'with', 'of', 'in', 'my', 'me', 'for', 'to', 'some', 'please', 'i', 'you', 'your', 'is', 'are', 'it', 'that', 'this']);

export function normalize(text, synonyms = DEFAULT_SYNONYMS) {
  const t = String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/(\d)\s*x\b/g, '$1 ').replace(/\bx\s*(\d)/g, ' $1').replace(/[^a-z0-9\s'-]/g, ' ').replace(/'/g, '').replace(/\s+/g, ' ').trim();
  return t.split(' ').map((w) => (Object.prototype.hasOwnProperty.call(synonyms, w) ? synonyms[w] : w)).filter((w) => w !== '').join(' ');
}
const stem = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const toks = (s) => s.split(' ').filter(Boolean);
const numOf = (w) => (/^\d{1,2}$/.test(w) ? Number(w) : WORD_NUM[w] ?? null);

/** A bare quantity ("two", "2", "make it 3", "a dozen") -> number, or null. */
export function parseQuantity(text, synonyms) {
  const n = normalize(text, synonyms).replace(/\b(make it|make that|only|just|i want|i need|give me|let it be|plates?|portions?|packs?|pieces?|of)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const w = toks(n); if (w.length !== 1) return null;
  const q = numOf(w[0]); return q >= 1 && q <= 50 ? q : null;
}

/** Finds menu items named in the text. Longer names win ("chicken and chips" beats "chicken"), and each gets the number said right before it. */
export function matchItems(text, menu, synonyms) {
  const words = toks(normalize(text, synonyms)); const sw = words.map(stem);
  const cands = [];
  for (const m of menu) {
    const nt = toks(normalize(m.name, synonyms)).filter((w) => !STOP.has(w)).map(stem); if (!nt.length) continue;
    // all of the item's words must appear, in order, within a short window
    let pos = -1, first = -1, ok = true;
    for (const w of nt) { const i = sw.indexOf(w, pos + 1); if (i < 0 || (pos >= 0 && i - pos > 4)) { ok = false; break; } if (first < 0) first = i; pos = i; }
    if (ok) cands.push({ m, start: first, end: pos, len: nt.length });
  }
  cands.sort((a, b) => b.len - a.len || a.start - b.start);
  const used = new Set(), out = [];
  for (const c of cands) {
    const span = []; for (let i = c.start; i <= c.end; i++) span.push(i);
    if (span.some((i) => used.has(i))) continue; span.forEach((i) => used.add(i));
    let qty = null, i = c.start - 1;
    while (i >= 0 && (UNIT_WORDS.has(words[i]) || STOP.has(words[i]))) i--;
    if (i >= 0) qty = numOf(words[i]);
    if (qty == null && words[c.end + 1] != null) qty = /^\d{1,2}$/.test(words[c.end + 1]) ? Number(words[c.end + 1]) : null; // "burger 2"
    out.push({ mealId: String(c.m.id), name: c.m.name, quantity: qty >= 1 && qty <= 50 ? qty : 1, explicitQty: qty != null, at: c.start });
  }
  return out.sort((a, b) => a.at - b.at).map(({ at, ...x }) => x);
}

const RX = {
  human: /\b(human|real person|agent|speak (to|with)|talk (to|with)|someone|somebody|manager|representative|call me|need (help|assistance)|assist me|restaurant staff|customer care|customer service)\b/,
  greet: /^(hi|hii+|hello|hey|hola|good (morning|afternoon|evening)|morning|afternoon|evening|how far|howdy|yo|sup)( there| sir| ma| boss)?$/,
  menu: /\b(menu|what do you (have|sell|offer)|what (food|meals?) do you|see (the )?(food|meals?)|show (me )?(the |your )?(food|meals?|items)|i want to order|want order|order (some )?food|start (an )?order|make an order|place an order|i would like to order|food list)\b/,
  cart: /\b(cart|basket|my order so far|whats in my (cart|basket|order))\b/,
  checkout: /\b(checkout|check out|pay now|place (my |the )?order|proceed|finish (my )?order|complete (my )?order|thats all|that is all|i am done|im done|done ordering|nothing else|confirm order)\b/,
  deliver: /\b(delivery|deliver|bring it|send it|dispatch)\b/,
  pickup: /\b(pick ?up|pick it up|collect|take ?away|come and take|i will come|ill come|come get|carry it myself)\b/,
  track: /\b(track|where is my order|wheres my order|order status|status of (my )?order|show my order|my order status|how far (is )?my order|wia my order|which time my order)\b/,
  clear: /\b(clear (my |the )?(cart|basket|order)|empty (my |the )?(cart|basket)|start over|restart)\b/,
  cancel: /\b(cancel)\b/,
  remove: /\b(remove|delete|take out|take off|drop|abeg remove|no remove)\b/,
  more: /\b(add another( one)?|another one|one more|add one more|plus one|one extra)\b/,
  setQty: /\b(make (it|that|them)|change (it |that )?to|let it be|reduce (it )?to|increase (it )?to|only)\b/,
  increase: /\bincrease (the )?(quantity|qty)\b/,
  price: /\b(how much|price of|cost of|whats the price|what is the price|how many naira)\b/,
  yes: /^(yes|yeah|yep|yup|ya|ok|okay|sure|correct|right|thats right|that is right|confirm|confirmed|i confirm|go ahead|proceed|true)$/,
  no: /^(no|nope|nah|not really|wrong|incorrect|change it|change)$/,
  help: /^(help|options|commands|what can you do)$/,
};

/**
 * @param {{ text:string, state?:string, menu:{id:string,name:string}[], cartLines?:number, synonyms?:object }} a
 * @returns {{ intent:string, confidence:number, entities:object, clarification:boolean, state:string }}
 */
export function readMessage({ text, state = 'greeting', menu = [], cartLines = 0, synonyms = DEFAULT_SYNONYMS }) {
  const n = normalize(text, synonyms);
  const done = (intent, confidence, entities = {}, clarification = false) => ({ intent, confidence, entities, clarification, state });
  if (!n) return done('UNKNOWN', 0, {}, true);

  const items = matchItems(text, menu, synonyms);
  const ref = /\bord-?[a-z0-9]{4,}\b/i.exec(String(text || ''))?.[0]?.toUpperCase().replace(/^ORD(?!-)/, 'ORD-');
  if (RX.human.test(n)) return done('HUMAN', 0.95);
  if (RX.greet.test(n)) return done('GREETING', 0.96);
  if (RX.track.test(n) || (ref && /track|status|where/.test(n))) return done('TRACK_ORDER', 0.92, { reference: ref });
  if (RX.clear.test(n)) return done('CLEAR_CART', 0.9);
  if (RX.cancel.test(n) && !items.length) return done('CANCEL', 0.85);
  if (RX.remove.test(n)) return items.length ? done('REMOVE_ITEM', 0.9, { items }) : done('REMOVE_ITEM', 0.78, { items: [], last: true }, false);
  if (RX.price.test(n)) return items.length ? done('PRICE_QUERY', 0.92, { items }) : done('PRICE_QUERY', 0.4, {}, true); // price of something we cannot find -> let the AI/clarify
  if (RX.more.test(n)) return done('INCREMENT_LAST', 0.9, { by: 1 });
  if (RX.increase.test(n) && !items.length) return done('INCREMENT_LAST', 0.8, { by: 1 });
  if (RX.setQty.test(n) && !items.length) {
    const q = toks(n).map(numOf).find((x) => x >= 1 && x <= 50);
    if (q) return done('SET_QUANTITY_LAST', 0.9, { quantity: q });
  }
  if (items.length) {
    // names with a number, or an order verb, are clearly an order; a bare name is a selection while browsing
    const verb = /\b(add|want|need|give|get|order|buy|take|bring|i would like|id like|can i (get|have)|put)\b/.test(n);
    const explicit = items.some((i) => i.explicitQty);
    const browsing = ['menu_browsing', 'product_selection', 'greeting', 'cart_management'].includes(state);
    return done('ADD_ITEMS', verb || explicit ? 0.92 : browsing ? 0.85 : 0.7, { items });
  }
  if (RX.checkout.test(n) && cartLines > 0) return done('CHECKOUT', 0.9);
  if (RX.pickup.test(n)) return done('SET_FULFILMENT', state === 'fulfilment_selection' ? 0.95 : 0.82, { fulfilment: 'pickup' });
  if (RX.deliver.test(n)) return done('SET_FULFILMENT', state === 'fulfilment_selection' ? 0.95 : 0.82, { fulfilment: 'delivery' });
  if (RX.cart.test(n)) return done('SHOW_CART', 0.92);
  if (RX.menu.test(n)) return done('SHOW_MENU', 0.92);
  if (RX.yes.test(n)) return done('YES', 0.9);
  if (RX.no.test(n)) return done('NO', 0.9);
  if (RX.help.test(n)) return done('HELP', 0.95);
  return done('UNKNOWN', 0.1, {}, true);
}

const GENERIC = new Set(['want', 'need', 'add', 'get', 'give', 'something', 'anything', 'food', 'eat', 'meal', 'meals', 'order', 'one', 'plate', 'plates', 'nice', 'good', 'lunch', 'dinner', 'breakfast', 'preferably', 'with', 'has', 'have', 'can', 'could', 'would', 'like', 'also', 'not', 'too', 'very', 'really', 'more', 'cheap', 'cheaper', 'expensive', 'filling', 'budget', 'that', 'this', 'what', 'which', 'recommend', 'suggest', 'for', 'and', 'the', 'some', 'any', 'you', 'your', 'are', 'there', 'got', 'show', 'see']);
/**
 * Plain menu search with no AI: dishes whose name or description contains a meaningful word from the text ("rice" -> every rice dish).
 * `cheap` lists the lowest prices first. Only real menu entries are ever returned.
 */
export function searchMenuItems(text, menu, { cheap = false, limit = 8, synonyms } = {}) {
  const words = toks(normalize(text, synonyms)).map(stem).filter((w) => w.length >= 3 && !GENERIC.has(w) && !GENERIC.has(w + 's'));
  let hits = menu;
  if (words.length) hits = menu.filter((m) => { const hay = toks(normalize(`${m.name} ${m.description || ''}`, synonyms)).map(stem); return words.some((w) => hay.includes(w)); });
  else if (!cheap) return [];
  if (cheap) hits = [...hits].sort((a, b) => a.price - b.price);
  return hits.slice(0, limit);
}
