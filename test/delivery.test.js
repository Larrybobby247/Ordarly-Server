import test from 'node:test';
import assert from 'node:assert/strict';
import { calcFee, resolveRules, DELIVERY_DEFAULTS, quoteDelivery, round1 } from '../src/services/delivery.js';
import { autocomplete, placeDetails, validPlaceId } from '../src/services/places.js';
import { drivingRoute } from '../src/services/routing.js';

process.env.JWT_SECRET = 'test-secret';
const realFetch = globalThis.fetch;
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const mockFetch = (fn) => { const calls = []; globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return fn(String(url), init); }; return calls; };
const keys = (g, l) => { g ? (process.env.GOOGLE_PLACES_API_KEY = 'g-key') : delete process.env.GOOGLE_PLACES_API_KEY; l ? (process.env.LOCATIONIQ_API_KEY = 'l-key') : delete process.env.LOCATIONIQ_API_KEY; };
test.afterEach(() => { globalThis.fetch = realFetch; });

/* ---------- pricing formula ---------- */
test('defaults are 1000 / 3 km / 200 / 15 km', () => {
  assert.deepEqual({ ...DELIVERY_DEFAULTS }, { baseFee: 1000, baseDistanceKm: 3, perKmRate: 200, maxRadiusKm: 15 });
});
test('default pricing table matches the brief', () => {
  const rules = resolveRules(undefined);
  const want = { 1: 1000, 2: 1000, 3: 1000, 4: 1200, 5: 1400, 7: 1800, 10: 2400, 15: 3400 };
  for (const [km, fee] of Object.entries(want)) assert.equal(calcFee(rules, Number(km)).fee, fee, `${km} km`);
});
test('partial extra kilometres are charged as a whole kilometre; beyond the radius is not deliverable', () => {
  const rules = resolveRules(undefined);
  assert.equal(calcFee(rules, 3.1).fee, 1200); assert.equal(calcFee(rules, 2.5).fee, 1000); assert.equal(calcFee(rules, 0).fee, 1000);
  assert.equal(calcFee(rules, 15).ok, true); assert.equal(calcFee(rules, 15.1).ok, false); assert.equal(calcFee(rules, NaN).ok, false);
});
test('floating point noise never adds a kilometre', () => {
  assert.equal(calcFee({ baseFee: 500, baseDistanceKm: 0.3, perKmRate: 100, maxRadiusKm: 20 }, 3.3).fee, 800);
});
test('existing restaurants keep their saved numbers; unconfigured ones get the defaults', () => {
  const saved = resolveRules({ configured: true, baseFee: 1500, baseDistanceKm: 2, perKmRate: 350, maxRadiusKm: 10 });
  assert.deepEqual(saved, { baseFee: 1500, baseDistanceKm: 2, perKmRate: 350, maxRadiusKm: 10, isDefault: false });
  assert.equal(resolveRules({ configured: false, baseFee: 0 }).isDefault, true);
  assert.equal(resolveRules({ configured: false, baseFee: 0 }).baseFee, 1000);
  assert.equal(resolveRules({ configured: true, baseFee: 0, baseDistanceKm: 3, perKmRate: 0, maxRadiusKm: 5 }).baseFee, 0); // a saved free-delivery rate stays free
});
test('round1', () => { assert.equal(round1(2.54), 2.5); assert.equal(round1(14.96), 15); });

/* ---------- routing ---------- */
test('routing sends LONGITUDE,LATITUDE and converts metres to km', async () => {
  keys(false, true);
  const calls = mockFetch(() => json({ code: 'Ok', routes: [{ distance: 2540, duration: 420 }] }));
  const r = await drivingRoute({ lat: 7.1475, lng: 3.3619 }, { lat: 7.16, lng: 3.35 });
  assert.match(calls[0].url, /\/directions\/driving\/3\.3619,7\.1475;3\.35,7\.16\?/);
  assert.equal(r.distanceKm, 2.54); assert.equal(r.durationMin, 7);
});
test('routing: no route and provider failures give friendly errors', async () => {
  keys(false, true);
  mockFetch(() => json({ code: 'NoRoute' }, 200));
  await assert.rejects(drivingRoute({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }), (e) => e.status === 422);
  mockFetch(() => json({ error: 'x' }, 500));
  await assert.rejects(drivingRoute({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }), (e) => e.status === 502);
  await assert.rejects(drivingRoute({ lat: 91, lng: 1 }, { lat: 2, lng: 2 }), (e) => e.status === 400);
});

/* ---------- places ---------- */
const gSuggest = { suggestions: [{ placePrediction: { placeId: 'ChIJabcdefghij12345', text: { text: 'Oke-Ilewo, Abeokuta, Nigeria' }, structuredFormat: { mainText: { text: 'Oke-Ilewo' }, secondaryText: { text: 'Abeokuta, Nigeria' } } } }] };
test('Google suggestions resolve to coordinates on the server and yield one standard shape', async () => {
  keys(true, true);
  mockFetch((url) => (url.includes(':autocomplete') ? json(gSuggest) : json({ id: 'x', formattedAddress: 'Oke-Ilewo, Abeokuta, Ogun, Nigeria', location: { latitude: 7.1601, longitude: 3.3481 } })));
  const [s] = await autocomplete('oke ilewo', { sessionToken: 'abc' });
  assert.equal(s.provider, 'google'); assert.ok(validPlaceId(s.placeId));
  const p = await placeDetails(s.placeId, 'abc');
  assert.deepEqual([p.lat, p.lng, p.googlePlaceId, p.address], [7.1601, 3.3481, 'ChIJabcdefghij12345', 'Oke-Ilewo, Abeokuta, Ogun, Nigeria']);
  const again = await placeDetails(p.placeId); // the resolved id needs no second Google call
  assert.equal(again.lat, 7.1601);
});
test('forged or edited place ids are rejected', async () => {
  keys(true, true);
  mockFetch((url) => (url.includes(':autocomplete') ? json(gSuggest) : json({})));
  const [s] = await autocomplete('oke');
  const [body, sig] = s.placeId.split('.');
  const evil = Buffer.from(JSON.stringify({ a: 'x', y: 1, x: 1 })).toString('base64url');
  await assert.rejects(placeDetails(`${evil}.${sig}`), (e) => e.status === 400);
  await assert.rejects(placeDetails(`${body}.${'A'.repeat(22)}`), (e) => e.status === 400);
});
test('falls back to LocationIQ when Google finds nothing or errors', async () => {
  keys(true, true);
  const liq = [{ lat: '7.15', lon: '3.35', display_name: 'Ita-Eko, Abeokuta, Ogun, Nigeria', display_place: 'Ita-Eko', display_address: 'Abeokuta' }];
  mockFetch((url) => (url.includes('googleapis') ? json({}) : json(liq)));
  let r = await autocomplete('ita eko'); assert.equal(r[0].provider, 'locationiq');
  mockFetch((url) => (url.includes('googleapis') ? json({ error: { message: 'denied' } }, 403) : json(liq)));
  r = await autocomplete('ita eko'); assert.equal(r[0].provider, 'locationiq');
  assert.equal((await placeDetails(r[0].placeId)).lat, 7.15); // LocationIQ results already carry coordinates
});
test('Google-only setup with no match says "no results"; Google down with no fallback is an error', async () => {
  keys(true, false);
  mockFetch(() => json({})); assert.deepEqual(await autocomplete('zzzz'), []);
  mockFetch(() => json({ error: {} }, 500)); await assert.rejects(autocomplete('zzzz'), (e) => e.status === 502);
});

/* ---------- full quote (same function the tester and checkout use) ---------- */
const rest = { fulfillment: { location: { lat: 7.1475, lng: 3.3619, address: 'Surulere, Ita-Eko, Abeokuta' }, radius: { configured: false } } };
const liqPlace = async () => { keys(true, true); mockFetch(() => json([{ lat: '7.16', lon: '3.35', display_name: 'Oke-Ilewo, Abeokuta' }])); const [s] = await autocomplete('oke'); return s.placeId; };
test('quote: 2.5 km by road costs the base fee with default settings', async () => {
  const id = await liqPlace();
  mockFetch(() => json({ code: 'Ok', routes: [{ distance: 2500, duration: 400 }] }));
  const q = await quoteDelivery(rest, id);
  assert.deepEqual([q.ok, q.distanceKm, q.fee], [true, 2.5, 1000]);
});
test('quote: outside the radius is not deliverable, and tester rules override saved ones', async () => {
  const id = await liqPlace();
  mockFetch(() => json({ code: 'Ok', routes: [{ distance: 16000, duration: 1200 }] }));
  assert.equal((await quoteDelivery(rest, id)).ok, false);
  const q = await quoteDelivery(rest, id, undefined, { rules: { baseFee: 500, baseDistanceKm: 3, perKmRate: 100, maxRadiusKm: 20 }, tester: true });
  assert.deepEqual([q.ok, q.fee], [true, 500 + 13 * 100]);
});
test('quote: router down -> error, except when the straight line already proves it is too far', async () => {
  const id = await liqPlace();
  mockFetch(() => json({}, 500));
  await assert.rejects(quoteDelivery(rest, id), (e) => e.status === 502);
  const far = { fulfillment: { ...rest.fulfillment, location: { lat: 6.5, lng: 3.3 } } }; // ~74 km away
  const q = await quoteDelivery(far, id); assert.equal(q.ok, false);
});
test('quote: restaurant with no saved location cannot deliver', async () => {
  const id = await liqPlace();
  await assert.rejects(quoteDelivery({ fulfillment: { radius: {} } }, id), (e) => e.status === 400);
});
