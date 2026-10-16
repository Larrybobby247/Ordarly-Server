// LocationIQ address autocomplete + distance helpers. The LocationIQ key lives ONLY on the server (LOCATIONIQ_API_KEY);
// the browser talks to our own /places endpoints, so no key is ever shipped to the frontend. No map is used: we only need
// address suggestions and their coordinates to calculate the delivery distance.
//
// How the "never trust the browser" rule is kept: LocationIQ's autocomplete already returns coordinates, so there is no second lookup.
// Instead each suggestion gets a `placeId` that is a SIGNED token holding the address + coordinates. When the customer or restaurant
// submits it, the server checks the signature (made with JWT_SECRET). A browser cannot invent or edit coordinates to get a cheaper fee,
// and this works across restarts and several server instances (no memory or database needed).
import crypto from 'crypto';

const KEY = () => process.env.LOCATIONIQ_API_KEY;
export const placesConfigured = () => !!KEY() && !!process.env.JWT_SECRET;

const fail = (msg, status) => Object.assign(new Error(msg), { status });

const sig = (body) => crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest('base64url').slice(0, 22);
function signPlace({ address, lat, lng }) {
  const body = Buffer.from(JSON.stringify({ a: address.slice(0, 140), y: Number(lat.toFixed(6)), x: Number(lng.toFixed(6)) })).toString('base64url');
  return `${body}.${sig(body)}`;
}
function readPlace(id) {
  if (!validPlaceId(id) || !process.env.JWT_SECRET) return null;
  const [body, given] = id.split('.');
  const want = sig(body);
  if (given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) return null; // forged or edited
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return typeof p.y === 'number' && typeof p.x === 'number' ? p : null; } catch { return null; }
}

export const validPlaceId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{20,900}\.[A-Za-z0-9_-]{22}$/.test(id);

export async function autocomplete(input, { bias } = {}) {
  if (!placesConfigured()) throw fail('Address search is not set up yet.', 503);
  const qs = new URLSearchParams({
    key: KEY(), q: String(input).slice(0, 200), countrycodes: 'ng', limit: '6', dedupe: '1', normalizecity: '1', 'accept-language': 'en',
  });
  if (bias?.lat != null && bias?.lng != null) { // prefer results near the restaurant (about 40 km box); still allows farther matches
    const d = 0.36; qs.set('viewbox', `${bias.lng - d},${bias.lat - d},${bias.lng + d},${bias.lat + d}`); qs.set('bounded', '0');
  }
  let res;
  try { res = await fetch(`https://api.locationiq.com/v1/autocomplete?${qs}`, { signal: AbortSignal.timeout(8000) }); }
  catch { throw fail('Address search is taking too long. Please try again.', 504); }
  if (res.status === 404) return []; // LocationIQ says "Unable to geocode" when nothing matches
  const data = await res.json().catch(() => null);
  if (res.status === 429) throw fail('Address search is busy. Please try again in a moment.', 429);
  if (!res.ok || !Array.isArray(data)) { console.error('[places] locationiq', res.status, data?.error || ''); throw fail('Address search is unavailable right now.', 502); }
  return data.filter((x) => x.lat && x.lon && x.display_name).map((x) => ({
    placeId: signPlace({ address: x.display_name, lat: Number(x.lat), lng: Number(x.lon) }),
    main: x.display_place || x.display_name.split(',')[0], secondary: x.display_address || '', text: x.display_name,
  }));
}

/** Turns a placeId from one of our suggestions back into { address, lat, lng } after checking the signature. No network call. */
export async function placeDetails(placeId) {
  if (!placesConfigured()) throw fail('Address search is not set up yet.', 503);
  const p = readPlace(placeId);
  if (!p) throw fail('Please pick an address from the list.', 400);
  return { placeId, address: p.a, lat: p.y, lng: p.x };
}

/** Straight-line distance in km (Haversine). */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Radius pricing. fee = baseFee for the first baseDistanceKm, then perKmRate for every extra km,
 * rounded UP to the next 100 naira so customers never see odd amounts. Past maxRadiusKm: not deliverable.
 */
export function radiusFee(radius, km) {
  const { baseFee, baseDistanceKm, perKmRate, maxRadiusKm } = radius;
  if (km > maxRadiusKm) return { ok: false };
  const raw = km <= baseDistanceKm ? baseFee : baseFee + (km - baseDistanceKm) * perKmRate;
  return { ok: true, fee: Math.ceil(raw / 100 - 1e-9) * 100 };
}

/** Full quote for a customer's place. Coordinates are resolved on the server from the signed place id, never taken from the browser. */
export async function quoteDelivery(rest, placeId, sessionToken) {
  const f = rest.fulfillment;
  if (!f?.radius?.configured || f.location?.lat == null) throw Object.assign(new Error('Delivery is not set up for this restaurant.'), { status: 400 });
  const place = await placeDetails(placeId, sessionToken);
  const km = haversineKm(f.location.lat, f.location.lng, place.lat, place.lng);
  const q = radiusFee(f.radius, km);
  return { place, distanceKm: Math.round(km * 10) / 10, ...q };
}
