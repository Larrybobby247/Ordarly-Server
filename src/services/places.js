// Mapbox Search Box API (suggest + retrieve) and distance helpers. The Mapbox token lives ONLY on the server
// (MAPBOX_ACCESS_TOKEN); the browser talks to our own /places endpoints for search, so no search token is shipped.
import crypto from 'crypto';

const TOKEN = () => process.env.MAPBOX_ACCESS_TOKEN;
export const placesConfigured = () => !!TOKEN();
const BASE = 'https://api.mapbox.com/search/searchbox/v1';

const ID_RE = /^[A-Za-z0-9_\-=.:]{8,500}$/;
export const validPlaceId = (id) => typeof id === 'string' && ID_RE.test(id);
const sess = (t) => (t && /^[A-Za-z0-9-]{8,64}$/.test(t) ? t : crypto.randomUUID());
const fail = (msg, status) => Object.assign(new Error(msg), { status });

export async function autocomplete(input, { bias, sessionToken } = {}) {
  if (!TOKEN()) throw fail('Address search is not set up yet.', 503);
  const qs = new URLSearchParams({
    q: String(input).slice(0, 200), access_token: TOKEN(), session_token: sess(sessionToken),
    country: 'ng', language: 'en', limit: '6',
  });
  if (bias?.lat != null && bias?.lng != null) qs.set('proximity', `${bias.lng},${bias.lat}`);
  const res = await fetch(`${BASE}/suggest?${qs}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('[places] suggest', res.status, data?.message || data?.error); throw fail('Address search is unavailable right now.', 502); }
  return (data.suggestions || []).filter((x) => x.mapbox_id).map((x) => ({
    placeId: x.mapbox_id, main: x.name, secondary: x.place_formatted || '',
    text: x.full_address || [x.name, x.place_formatted].filter(Boolean).join(', '),
  }));
}

const cache = new Map(); // placeId -> { at, value }; a place's coordinates don't change, so a short cache saves API calls
export async function placeDetails(placeId, sessionToken) {
  if (!TOKEN()) throw fail('Address search is not set up yet.', 503);
  if (!validPlaceId(placeId)) throw fail('Please pick an address from the list.', 400);
  const hit = cache.get(placeId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const qs = new URLSearchParams({ access_token: TOKEN(), session_token: sess(sessionToken), language: 'en' });
  const res = await fetch(`${BASE}/retrieve/${encodeURIComponent(placeId)}?${qs}`);
  const data = await res.json().catch(() => ({}));
  const f = data?.features?.[0];
  const [lng, lat] = f?.geometry?.coordinates || [];
  if (!res.ok || typeof lat !== 'number' || typeof lng !== 'number') { console.error('[places] retrieve', res.status, data?.message || data?.error); throw fail('We could not find that address. Please pick another.', 400); }
  const pr = f.properties || {};
  const value = { placeId, address: pr.full_address || [pr.name, pr.place_formatted].filter(Boolean).join(', '), lat, lng };
  if (cache.size > 500) cache.clear();
  cache.set(placeId, { at: Date.now(), value });
  return value;
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

/** Full quote for a customer's place. Coordinates are resolved on the server from the Mapbox place id, never taken from the browser. */
export async function quoteDelivery(rest, placeId, sessionToken) {
  const f = rest.fulfillment;
  if (!f?.radius?.configured || f.location?.lat == null) throw Object.assign(new Error('Delivery is not set up for this restaurant.'), { status: 400 });
  const place = await placeDetails(placeId, sessionToken);
  const km = haversineKm(f.location.lat, f.location.lng, place.lat, place.lng);
  const q = radiusFee(f.radius, km);
  return { place, distanceKm: Math.round(km * 10) / 10, ...q };
}
