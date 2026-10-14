// Google Places (New) + distance helpers. The Google key lives ONLY on the server (GOOGLE_MAPS_API_KEY);
// the browser talks to our own /places endpoints, so no key is ever shipped to the frontend.
const KEY = () => process.env.GOOGLE_MAPS_API_KEY;
export const placesConfigured = () => !!KEY();

const ID_RE = /^[A-Za-z0-9_-]{10,300}$/;
export const validPlaceId = (id) => typeof id === 'string' && ID_RE.test(id);

export async function autocomplete(input, { bias, sessionToken } = {}) {
  if (!KEY()) throw Object.assign(new Error('Address search is not set up yet.'), { status: 503 });
  const body = { input: String(input).slice(0, 120), includedRegionCodes: ['ng'], languageCode: 'en' };
  if (sessionToken) body.sessionToken = String(sessionToken).slice(0, 64);
  if (bias?.lat != null && bias?.lng != null) {
    body.locationBias = { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: Math.min(50000, Math.max(1000, bias.radiusM || 30000)) } };
  }
  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY(),
      'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.text',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('[places] autocomplete', res.status, data?.error?.message); throw Object.assign(new Error('Address search is unavailable right now.'), { status: 502 }); }
  return (data.suggestions || []).filter((s) => s.placePrediction).map(({ placePrediction: p }) => ({
    placeId: p.placeId, main: p.structuredFormat?.mainText?.text || p.text?.text, secondary: p.structuredFormat?.secondaryText?.text || '', text: p.text?.text,
  }));
}

const cache = new Map(); // placeId -> { at, value }; coordinates of a place don't change, so a short cache saves API calls
export async function placeDetails(placeId, sessionToken) {
  if (!KEY()) throw Object.assign(new Error('Address search is not set up yet.'), { status: 503 });
  if (!validPlaceId(placeId)) throw Object.assign(new Error('Please pick an address from the list.'), { status: 400 });
  const hit = cache.get(placeId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const qs = sessionToken ? `?sessionToken=${encodeURIComponent(String(sessionToken).slice(0, 64))}` : '';
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${qs}`, {
    headers: { 'X-Goog-Api-Key': KEY(), 'X-Goog-FieldMask': 'id,formattedAddress,location,displayName' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.location) { console.error('[places] details', res.status, data?.error?.message); throw Object.assign(new Error('We could not find that address. Please pick another.'), { status: 400 }); }
  const value = { placeId, address: data.formattedAddress || data.displayName?.text || '', lat: data.location.latitude, lng: data.location.longitude };
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

/** Full quote for a customer's place. Coordinates are resolved on the server from the Google place id, never taken from the browser. */
export async function quoteDelivery(rest, placeId, sessionToken) {
  const f = rest.fulfillment;
  if (!f?.radius?.configured || f.location?.lat == null) throw Object.assign(new Error('Delivery is not set up for this restaurant.'), { status: 400 });
  const place = await placeDetails(placeId, sessionToken);
  const km = haversineKm(f.location.lat, f.location.lng, place.lat, place.lng);
  const q = radiusFee(f.radius, km);
  return { place, distanceKm: Math.round(km * 10) / 10, ...q };
}
