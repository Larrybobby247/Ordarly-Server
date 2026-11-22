// Driving distance and time between two points, from the LocationIQ Directions API. This is the ONE routing implementation:
// the restaurant's "Test your delivery charges" tool and customer checkout both reach it through delivery.js.
// The key is server-side only (LOCATIONIQ_API_KEY). Set LOCATIONIQ_REGION (us1, eu1 or ap1) if your LocationIQ account uses another region.

const fail = (msg, status, code) => Object.assign(new Error(msg), { status, code });
const isCoord = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

export const routingConfigured = () => !!process.env.LOCATIONIQ_API_KEY;

/** Straight-line distance in km (Haversine). Only used as a quick "obviously too far" check, never to price a delivery. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// LocationIQ (like most routing APIs) wants coordinates as LONGITUDE,LATITUDE, the opposite of how people say them.
// Everything else in Ordarly uses { lat, lng }; this is the only place that flips the order.
const lngLat = (p) => `${p.lng},${p.lat}`;

const REGION = () => (/^[a-z]{2}\d$/.test(process.env.LOCATIONIQ_REGION || '') ? process.env.LOCATIONIQ_REGION : 'us1');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Driving route from one { lat, lng } to another. Resolves to { distanceKm, durationMin } (unrounded). Throws an Error with a friendly message and `status`. */
export async function drivingRoute(from, to) {
  if (!routingConfigured()) throw fail('Distance calculation is not set up yet.', 503, 'ROUTING_OFF');
  if (!isCoord(from) || !isCoord(to)) throw fail('That address has no usable map position. Please pick another one.', 400, 'BAD_COORDS');
  const url = `https://${REGION()}.locationiq.com/v1/directions/driving/${lngLat(from)};${lngLat(to)}?${new URLSearchParams({ key: process.env.LOCATIONIQ_API_KEY, overview: 'false', steps: 'false', alternatives: 'false' })}`;

  let res, data;
  for (let attempt = 0; attempt < 2; attempt++) { // one retry: LocationIQ rate-limits bursts (429) and has the odd blip (5xx)
    try { res = await fetch(url, { signal: AbortSignal.timeout(8000) }); }
    catch { if (attempt) throw fail('Working out the driving distance is taking too long. Please try again.', 504, 'ROUTE_TIMEOUT'); await wait(400); continue; }
    if ((res.status === 429 || res.status >= 500) && !attempt) { await wait(700); continue; }
    break;
  }
  data = await res.json().catch(() => null);
  if (res.status === 404 || data?.code === 'NoRoute') throw fail('We could not find a driving route to that address.', 422, 'NO_ROUTE');
  if (res.status === 429) throw fail('Distance calculation is busy. Please try again in a moment.', 429, 'ROUTE_BUSY');
  if (!res.ok || data?.code !== 'Ok' || !Array.isArray(data.routes) || !Number.isFinite(data.routes[0]?.distance)) {
    console.error('[routing] locationiq', res.status, data?.code || data?.error || '');
    throw fail('We could not work out the driving distance right now. Please try again.', 502, 'ROUTE_FAILED');
  }
  const r0 = data.routes[0];
  return { distanceKm: r0.distance / 1000, durationMin: Number.isFinite(r0.duration) ? r0.duration / 60 : null };
}
