// Address search. Google Places is the main provider (suggestions + place details). LocationIQ autocomplete is kept ONLY as a
// fallback for when Google finds nothing or is unavailable. Road distances are NOT calculated here: see routing.js (LocationIQ).
//
// Keys live ONLY on the server (GOOGLE_PLACES_API_KEY, LOCATIONIQ_API_KEY). The browser talks to our own /places endpoints,
// so no key is ever shipped to the frontend.
//
// How the "never trust the browser" rule is kept: every suggestion gets a `placeId` that is a SIGNED token (signed with JWT_SECRET).
//  - LocationIQ suggestions already carry coordinates, so their token holds address + coordinates.
//  - Google suggestions carry no coordinates, so their token holds address + Google place id. placeDetails() asks Google for the
//    coordinates (one Place Details call, billed in the same session as the typing) and returns a NEW signed token that holds them.
// A browser cannot invent or edit coordinates to get a cheaper fee, and this works across restarts and several server
// instances (no memory or database needed). Everything downstream (fee tester, checkout, saved locations) only ever sees
// { placeId, address, lat, lng, googlePlaceId } in one standard shape, whichever provider produced it.
import crypto from 'crypto';

const GOOGLE_KEY = () => process.env.GOOGLE_PLACES_API_KEY;
const LOCATIONIQ_KEY = () => process.env.LOCATIONIQ_API_KEY;

export const googleConfigured = () => !!GOOGLE_KEY();
/** Can we search for addresses at all (Google and/or LocationIQ, plus the signing secret)? */
export const placesConfigured = () => (!!GOOGLE_KEY() || !!LOCATIONIQ_KEY()) && !!process.env.JWT_SECRET;

const fail = (msg, status) => Object.assign(new Error(msg), { status });

/* ---------- signed place tokens ---------- */
const sig = (body) => crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest('base64url').slice(0, 22);
const GOOGLE_ID = /^[A-Za-z0-9_-]{10,300}$/;

function signPlace({ address, lat, lng, g }) {
  const o = { a: String(address).slice(0, 160) };
  if (typeof lat === 'number' && typeof lng === 'number') { o.y = Number(lat.toFixed(6)); o.x = Number(lng.toFixed(6)); }
  if (g && GOOGLE_ID.test(g)) o.g = g;
  const body = Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${body}.${sig(body)}`;
}
function readPlace(id) {
  if (!validPlaceId(id) || !process.env.JWT_SECRET) return null;
  const [body, given] = id.split('.');
  const want = sig(body);
  if (given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) return null; // forged or edited
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    const hasCoords = typeof p.y === 'number' && typeof p.x === 'number';
    return typeof p.a === 'string' && (hasCoords || (typeof p.g === 'string' && GOOGLE_ID.test(p.g))) ? p : null;
  } catch { return null; }
}

export const validPlaceId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{20,1200}\.[A-Za-z0-9_-]{22}$/.test(id);

// Google session tokens must be URL-safe and at most 36 characters. Anything else is simply not sent (billing still works, just per request).
const googleSession = (t) => (typeof t === 'string' && /^[A-Za-z0-9_-]{1,36}$/.test(t) ? t : undefined);

/* ---------- Google Places (New) ---------- */
async function googleAutocomplete(input, { sessionToken, bias } = {}) {
  const body = { input: String(input).slice(0, 200), includedRegionCodes: ['ng'], languageCode: 'en' };
  const st = googleSession(sessionToken); if (st) body.sessionToken = st;
  if (bias?.lat != null && bias?.lng != null) { // prefer results near the restaurant; still allows farther matches
    body.locationBias = { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: Math.min(Math.max(Number(bias.radiusM) || 20000, 1000), 50000) } };
  }
  let res;
  try {
    res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_KEY(), 'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat' },
      body: JSON.stringify(body),
    });
  } catch { throw fail('Address search is taking too long. Please try again.', 504); }
  const data = await res.json().catch(() => null);
  if (res.status === 429) throw fail('Address search is busy. Please try again in a moment.', 429);
  if (!res.ok) { console.error('[places] google autocomplete', res.status, data?.error?.message || ''); throw fail('Address search is unavailable right now.', 502); }
  return (data?.suggestions || []).map((s) => s.placePrediction).filter((p) => p?.placeId && p.text?.text && GOOGLE_ID.test(p.placeId)).slice(0, 6).map((p) => ({
    placeId: signPlace({ address: p.text.text, g: p.placeId }),
    main: p.structuredFormat?.mainText?.text || p.text.text.split(',')[0],
    secondary: p.structuredFormat?.secondaryText?.text || '',
    text: p.text.text, provider: 'google',
  }));
}

async function googleDetails(googlePlaceId, sessionToken) {
  const st = googleSession(sessionToken);
  let res;
  try {
    res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(googlePlaceId)}?languageCode=en${st ? `&sessionToken=${st}` : ''}`, {
      signal: AbortSignal.timeout(8000), headers: { 'X-Goog-Api-Key': GOOGLE_KEY(), 'X-Goog-FieldMask': 'id,formattedAddress,location' },
    });
  } catch { throw fail('Address lookup is taking too long. Please try again.', 504); }
  const data = await res.json().catch(() => null);
  if (res.status === 429) throw fail('Address search is busy. Please try again in a moment.', 429);
  if (res.status === 404 || res.status === 400) throw fail('We could not find that address. Please search again and pick one from the list.', 400);
  if (!res.ok) { console.error('[places] google details', res.status, data?.error?.message || ''); throw fail('Address lookup is unavailable right now.', 502); }
  const lat = Number(data?.location?.latitude), lng = Number(data?.location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw fail('We could not find that address. Please search again and pick one from the list.', 400);
  return { address: data.formattedAddress || '', lat, lng };
}

/* ---------- LocationIQ autocomplete (fallback only) ---------- */
async function locationiqAutocomplete(input, { bias } = {}) {
  const qs = new URLSearchParams({
    key: LOCATIONIQ_KEY(), q: String(input).slice(0, 200), countrycodes: 'ng', limit: '6', dedupe: '1', normalizecity: '1', 'accept-language': 'en',
  });
  if (bias?.lat != null && bias?.lng != null) { // about 40 km box; still allows farther matches
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
    main: x.display_place || x.display_name.split(',')[0], secondary: x.display_address || '', text: x.display_name, provider: 'locationiq',
  }));
}

/**
 * Address suggestions: Google first; if Google finds nothing (or is down) and LocationIQ is configured, LocationIQ answers instead,
 * so an owner or customer is never left with a dead end. Each suggestion says which provider it came from (`provider`) so the UI can credit it.
 */
export async function autocomplete(input, { sessionToken, bias } = {}) {
  if (!placesConfigured()) throw fail('Address search is not set up yet.', 503);
  let google = null, googleError = null;
  if (googleConfigured()) {
    try { google = await googleAutocomplete(input, { sessionToken, bias }); } catch (e) { googleError = e; }
  }
  if (google?.length) return google;
  if (LOCATIONIQ_KEY()) {
    try { return await locationiqAutocomplete(input, { bias }); }
    catch (e) { if (google) return []; throw googleError || e; } // Google worked (just no match): "no results" is the honest answer
  }
  if (googleError) throw googleError;
  return google || [];
}

/**
 * Turns a placeId from one of our suggestions back into { placeId, address, lat, lng, googlePlaceId } after checking the signature.
 * The returned placeId always holds coordinates, so passing it on (e.g. from the checkout quote to the order) needs no second Google call.
 */
export async function placeDetails(placeId, sessionToken) {
  if (!placesConfigured()) throw fail('Address search is not set up yet.', 503);
  const p = readPlace(placeId);
  if (!p) throw fail('Please pick an address from the list.', 400);
  if (typeof p.y === 'number' && typeof p.x === 'number') return { placeId, address: p.a, lat: p.y, lng: p.x, googlePlaceId: p.g };
  if (!googleConfigured()) throw fail('Address search is not set up yet.', 503);
  const d = await googleDetails(p.g, sessionToken);
  const address = d.address || p.a;
  return { placeId: signPlace({ address, lat: d.lat, lng: d.lng, g: p.g }), address, lat: d.lat, lng: d.lng, googlePlaceId: p.g };
}

/** The standard shape we store for a restaurant or branch location. */
export const toLocation = (p) => ({ placeId: p.placeId, address: p.address, lat: p.lat, lng: p.lng, ...(p.googlePlaceId && { googlePlaceId: p.googlePlaceId }) });

/** A location the customer shared on WhatsApp (a map pin) as the same signed place used everywhere else, so it needs no further lookup and cannot be edited. */
export function signedPlaceFromCoords({ lat, lng, address }) {
  if (!process.env.JWT_SECRET) throw fail('Address search is not set up yet.', 503);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw fail('That location is not usable.', 400);
  return signPlace({ address: address || `Pinned location (${lat.toFixed(5)}, ${lng.toFixed(5)})`, lat, lng });
}
