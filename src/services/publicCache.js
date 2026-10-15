// PERF (new): tiny in-memory cache for the PUBLIC restaurant page data (menu, hours, checkout options).
// Why: this is the hottest endpoint (every customer visit) and the data changes rarely. Without it every visit ran 4-5 database queries.
// Safe because: it only holds data that is already public, the key is the restaurant slug/domain (never a user), entries live 30 seconds,
// and ALL of it is cleared as soon as the owner changes anything (menu, settings, payments). Orders are always re-priced from the database
// at checkout, so a cached price can never be charged. Single-server memory only (no Redis needed); each server instance keeps its own copy.
const TTL_MS = 30 * 1000;
const MAX = 500;
const store = new Map(); // key -> { at, value }

export function getCached(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) { store.delete(key); return undefined; }
  return hit.value;
}
export function setCached(key, value) {
  if (store.size >= MAX) store.delete(store.keys().next().value); // drop the oldest entry
  store.set(key, { at: Date.now(), value });
}
export const clearPublicCache = () => store.clear();

// Express middleware: after any successful non-GET request on a router, clear the cache so owners see their changes at once.
export const clearCacheOnWrite = (req, res, next) => {
  if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) clearPublicCache(); });
  next();
};
