// Delivery pricing: ONE formula and ONE quote function, used by the dashboard's fee tester AND customer checkout.
// Never price a delivery anywhere else. (The dashboard preview table re-implements calcFee in the browser purely for instant feedback;
// test/delivery.test.js keeps the two in step, and the server always recalculates.)
import { placeDetails, placesConfigured } from './places.js';
import { drivingRoute, haversineKm, routingConfigured } from './routing.js';

/** Defaults for a restaurant that has never saved delivery prices. Existing saved settings are never overwritten by these. */
export const DELIVERY_DEFAULTS = Object.freeze({ baseFee: 1000, baseDistanceKm: 3, perKmRate: 200, maxRadiusKm: 15 });

/** Delivery needs address search + road routing + the signing secret. */
export const deliveryConfigured = () => placesConfigured() && routingConfigured();

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * The four numbers that apply to a restaurant/branch: what it saved if it has configured delivery, otherwise the defaults.
 * `isDefault` tells the dashboard whether the owner has saved their own values yet.
 */
export function resolveRules(radius) {
  if (radius?.configured) {
    return {
      baseFee: num(radius.baseFee, DELIVERY_DEFAULTS.baseFee), baseDistanceKm: num(radius.baseDistanceKm, DELIVERY_DEFAULTS.baseDistanceKm) || DELIVERY_DEFAULTS.baseDistanceKm,
      perKmRate: num(radius.perKmRate, DELIVERY_DEFAULTS.perKmRate), maxRadiusKm: num(radius.maxRadiusKm, DELIVERY_DEFAULTS.maxRadiusKm) || DELIVERY_DEFAULTS.maxRadiusKm, isDefault: false,
    };
  }
  return { ...DELIVERY_DEFAULTS, isDefault: true };
}

export const round1 = (km) => Math.round(km * 10) / 10;

/**
 * extraDistance = Math.max(0, distanceKm - baseDistance)
 * deliveryFee   = baseFee + Math.ceil(extraDistance) * additionalFeePerKm
 * Only for distances within the maximum delivery radius. `distanceKm` should already be rounded to 0.1 km (what the customer sees).
 * The 1e-9 only protects against floating-point noise (e.g. 3.3 - 0.3 = 3.0000000000000004), it never changes a real result.
 */
export function calcFee(rules, distanceKm) {
  if (!(distanceKm <= rules.maxRadiusKm)) return { ok: false };
  const extraDistance = Math.max(0, distanceKm - rules.baseDistanceKm);
  return { ok: true, fee: rules.baseFee + Math.ceil(extraDistance - 1e-9) * rules.perKmRate };
}

/**
 * Full quote: road distance from the restaurant (or branch) to the customer's place, then the fee.
 * Coordinates are resolved on the server from the signed place id, never taken from the browser.
 * `opts.rules` / `opts.origin` let the dashboard tester try unsaved values; checkout never passes them.
 * Resolves to { place, distanceKm, durationMin, ok, fee?, rules }. `ok:false` means outside the delivery radius.
 */
export async function quoteDelivery(rest, placeId, sessionToken, opts = {}) {
  const f = rest.fulfillment;
  const origin = opts.origin || f?.location;
  if (origin?.lat == null) throw Object.assign(new Error(opts.tester ? 'Search for and pick your restaurant address first.' : 'Delivery is not set up for this restaurant.'), { status: 400 });
  const rules = opts.rules || resolveRules(f.radius);
  const place = await placeDetails(placeId, sessionToken);

  let route;
  try { route = await drivingRoute({ lat: origin.lat, lng: origin.lng }, { lat: place.lat, lng: place.lng }); }
  catch (e) {
    // A road is never shorter than the straight line, so if even the straight line is beyond the radius the answer is "outside" no matter what the router says.
    if (haversineKm(origin.lat, origin.lng, place.lat, place.lng) > rules.maxRadiusKm) return { place, distanceKm: null, durationMin: null, ok: false, rules };
    throw e;
  }
  const distanceKm = round1(route.distanceKm);
  return { place, distanceKm, durationMin: route.durationMin == null ? null : Math.max(1, Math.round(route.durationMin)), rules, ...calcFee(rules, distanceKm) };
}
