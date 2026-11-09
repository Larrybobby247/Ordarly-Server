import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSale, commissionOf, commissionKobo } from '../src/services/earningsMath.js';
import { generateSlots, isValidSlot, DEFAULT_SCHEDULING } from '../src/services/schedule.js';
import { zonedToUtc, rangeBounds, localDay, startOfLocalDay } from '../src/services/tz.js';
import { buildAccess, can, canBranch, branchFilter, canGrant, staffRouteAllowed, OWNER_ACCESS, scopedQuery } from '../src/services/access.js';
import { mergePlanConfig, DEFAULT_PLAN_CONFIG, commissionPctFor, yearlyQuote } from '../src/config/plans.js';

/* ---------- commission ---------- */
test('Free plan: 20,000 meals + 2,000 delivery -> commission 1,000, restaurant gets 21,000', () => {
  const s = computeSale({ mealSubtotal: 20000, deliveryFee: 2000, commissionPct: 5 });
  assert.equal(s.total, 22000); assert.equal(s.commission, 1000); assert.equal(s.net, 21000);
});
test('delivery fee never attracts commission', () => {
  assert.equal(computeSale({ mealSubtotal: 0, deliveryFee: 5000, commissionPct: 5 }).commission, 0);
  assert.equal(commissionOf(20000, 5), 1000);
});
test('worked example from the brief: 500,000 meals + 50,000 delivery -> 25,000 commission, 525,000 net', () => {
  const s = computeSale({ mealSubtotal: 500000, deliveryFee: 50000, commissionPct: 5 }); assert.equal(s.commission, 25000); assert.equal(s.net, 525000);
});
test('Pro and Business pay 0% commission', () => {
  assert.equal(computeSale({ mealSubtotal: 20000, deliveryFee: 2000, commissionPct: commissionPctFor(DEFAULT_PLAN_CONFIG, 'pro') }).net, 22000);
  assert.equal(commissionPctFor(DEFAULT_PLAN_CONFIG, 'business'), 0);
});
test('partial refund is proportional; full refund means no commission and nothing earned', () => {
  const half = computeSale({ mealSubtotal: 20000, deliveryFee: 2000, commissionPct: 5, refunded: 11000 });
  assert.equal(half.commission, 500); assert.equal(half.net, 10500); assert.equal(half.commissionReleased, 500);
  const full = computeSale({ mealSubtotal: 20000, deliveryFee: 2000, commissionPct: 5, refunded: 22000 });
  assert.equal(full.commission, 0); assert.equal(full.net, 0); assert.equal(full.fullyRefunded, true);
  assert.equal(computeSale({ mealSubtotal: 20000, deliveryFee: 2000, commissionPct: 5, refunded: 99999 }).net, 0); // over-refund is clamped
});
test('kobo amount for the Paystack split comes from the meal subtotal only', () => {
  assert.equal(commissionKobo(20000, 5), 100000); assert.equal(commissionKobo(20000, 0), 0); assert.equal(commissionKobo(1234.5, 5), 6173);
});
test('plan config: stored settings from before the new plans still get commission + business defaults', () => {
  const m = mergePlanConfig({ free: { maxActiveMeals: 10 }, pro: { priceNgn: 9000, trialDays: 7 } });
  assert.equal(m.free.commissionPct, 5); assert.equal(m.pro.priceNgn, 9000); assert.equal(m.business.enabled, false); assert.equal(m.business.maxBranches, 0);
  assert.equal(yearlyQuote({ ...m, business: { priceNgn: 30000 } }, 'business').price, 342000);
});

/* ---------- time zones ---------- */
test('Lagos (UTC+1) day boundaries and DST-free conversion', () => {
  assert.equal(zonedToUtc(2026, 11, 8, 0, 0, 'Africa/Lagos').toISOString(), '2026-11-07T23:00:00.000Z');
  assert.equal(localDay(new Date('2026-11-08T23:30:00Z'), 'Africa/Lagos').ymd, '2026-11-09'); // already tomorrow in Lagos
});
test('DST zone is handled (New York spring forward)', () => {
  assert.equal(zonedToUtc(2026, 3, 8, 12, 0, 'America/New_York').toISOString(), '2026-03-08T16:00:00.000Z'); // EDT, UTC-4
  assert.equal(zonedToUtc(2026, 3, 7, 12, 0, 'America/New_York').toISOString(), '2026-03-07T17:00:00.000Z'); // EST, UTC-5
});
test('earnings date ranges', () => {
  const now = new Date('2026-11-18T10:00:00Z'); const o = { now, tz: 'Africa/Lagos' };
  assert.equal(rangeBounds('today', o).from.toISOString(), '2026-11-17T23:00:00.000Z');
  assert.equal(rangeBounds('yesterday', o).to.toISOString(), '2026-11-17T23:00:00.000Z');
  assert.equal(rangeBounds('7d', o).from.toISOString(), '2026-11-11T23:00:00.000Z');
  assert.equal(rangeBounds('month', o).from.toISOString(), '2026-10-31T23:00:00.000Z');
  const lm = rangeBounds('lastmonth', o); assert.equal(lm.from.toISOString(), '2026-09-30T23:00:00.000Z'); assert.equal(lm.to.toISOString(), '2026-10-31T23:00:00.000Z');
  const c = rangeBounds('custom', { ...o, from: '2026-11-01', to: '2026-11-03' }); assert.equal(c.to.toISOString(), '2026-11-03T23:00:00.000Z'); // 3rd included
  assert.equal(rangeBounds('custom', { ...o, from: '2026-11-05', to: '2026-11-01' }), null);
  assert.equal(rangeBounds('all', o), null);
});

/* ---------- scheduled orders ---------- */
const HOURS = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '09:00', close: '21:00', closed: day === 0 })); // Sunday closed
const CFG = { ...DEFAULT_SCHEDULING, enabled: true, minNoticeMinutes: 60, slotMinutes: 30, maxDaysAhead: 7, capacityPerSlot: 2 };
const NOW = new Date('2026-11-09T08:00:00Z'); // Monday 09:00 in Lagos

test('slots respect opening hours, step, minimum notice', () => {
  const s = generateSlots({ dateStr: '2026-11-09', hours: HOURS, cfg: CFG, now: NOW });
  assert.equal(s[0].time, '09:00'); assert.equal(s[0].available, false); assert.equal(s[0].reason, 'too_soon'); // only 09:00 now, needs 60 min notice
  assert.equal(s.find((x) => x.time === '10:00').available, true);
  assert.equal(s.at(-1).time, '20:30'); assert.equal(s.length, 24);
});
test('never the past, never beyond the booking window, closed days empty, bad dates empty', () => {
  assert.deepEqual(generateSlots({ dateStr: '2026-11-08', hours: HOURS, cfg: CFG, now: NOW }), []);       // yesterday
  assert.deepEqual(generateSlots({ dateStr: '2026-11-30', hours: HOURS, cfg: CFG, now: NOW }), []);       // too far ahead
  assert.deepEqual(generateSlots({ dateStr: '2026-11-15', hours: HOURS, cfg: CFG, now: NOW }), []);       // Sunday closed
  assert.deepEqual(generateSlots({ dateStr: '2026-02-31', hours: HOURS, cfg: CFG, now: NOW }), []);
  assert.deepEqual(generateSlots({ dateStr: '2026-11-10', hours: HOURS, cfg: CFG, now: NOW, acceptingOrders: false }), []);
});
test('branch hours: a branch that closes earlier offers fewer slots than the restaurant', () => {
  const branchHours = HOURS.map((h) => ({ ...h, close: '15:00' }));
  assert.equal(generateSlots({ dateStr: '2026-11-10', hours: branchHours, cfg: CFG, now: NOW }).at(-1).time, '14:30');
});
test('capacity: a full slot is unavailable and cannot be forced at checkout', () => {
  const start = zonedToUtc(2026, 11, 10, 12, 0, 'Africa/Lagos').toISOString();
  const booked = { [start]: 2 };
  assert.equal(generateSlots({ dateStr: '2026-11-10', hours: HOURS, cfg: CFG, now: NOW, booked }).find((x) => x.start === start).reason, 'full');
  assert.equal(isValidSlot({ startISO: start, hours: HOURS, cfg: CFG, now: NOW, booked }), false);
  assert.equal(isValidSlot({ startISO: start, hours: HOURS, cfg: CFG, now: NOW, booked: { [start]: 1 } }), true);
});
test('checkout validation rejects off-grid, past, closed and closed-hours times', () => {
  const v = (iso) => isValidSlot({ startISO: iso, hours: HOURS, cfg: CFG, now: NOW });
  assert.equal(v(zonedToUtc(2026, 11, 10, 12, 15, 'Africa/Lagos').toISOString()), false); // not on a 30-min boundary
  assert.equal(v(zonedToUtc(2026, 11, 10, 22, 0, 'Africa/Lagos').toISOString()), false);  // after closing
  assert.equal(v(zonedToUtc(2026, 11, 8, 12, 0, 'Africa/Lagos').toISOString()), false);   // past
  assert.equal(v(zonedToUtc(2026, 11, 15, 12, 0, 'Africa/Lagos').toISOString()), false);  // Sunday
  assert.equal(v('not a date'), false);
  assert.equal(v(zonedToUtc(2026, 11, 10, 12, 0, 'Africa/Lagos').toISOString()), true);
});
test('no opening hours configured -> sensible default window, not 24h', () => {
  const s = generateSlots({ dateStr: '2026-11-10', hours: [], cfg: CFG, now: NOW }); assert.equal(s[0].time, '08:00'); assert.equal(s.at(-1).time, '20:30');
});
test('unlimited capacity (0) never reports full', () => {
  const start = zonedToUtc(2026, 11, 10, 12, 0, 'Africa/Lagos').toISOString();
  assert.equal(generateSlots({ dateStr: '2026-11-10', hours: HOURS, cfg: { ...CFG, capacityPerSlot: 0 }, now: NOW, booked: { [start]: 500 } }).find((x) => x.start === start).available, true);
});

/* ---------- staff access ---------- */
const A = '64b000000000000000000001', B = '64b000000000000000000002', C = '64b000000000000000000003';
const branchMgr = buildAccess({ role: 'branch_manager', branches: [A] });
const allMgr = buildAccess({ role: 'all_branches_manager', branches: [] });
const custom = buildAccess({ role: 'custom', perms: ['orders', 'analytics'], branches: [A, B], allBranches: false });

test('a branch manager can only reach their branch', () => {
  assert.equal(canBranch(branchMgr, A), true); assert.equal(canBranch(branchMgr, B), false);
  assert.deepEqual(branchFilter(branchMgr), { branch: { $in: [A] } });
  assert.equal(can(branchMgr, 'menu'), true); assert.equal(can(branchMgr, 'staff'), false); assert.equal(can(branchMgr, 'branches'), false);
});
test('an all-branches manager reaches every branch with no filter', () => {
  assert.equal(canBranch(allMgr, C), true); assert.deepEqual(branchFilter(allMgr), {}); assert.equal(can(allMgr, 'branches'), true);
});
test('custom access is exactly what was granted', () => {
  assert.equal(can(custom, 'orders'), true); assert.equal(can(custom, 'menu'), false);
  assert.equal(canBranch(custom, B), true); assert.equal(canBranch(custom, C), false);
});
test('staff are default-denied from owner-only areas; owner is never restricted', () => {
  for (const [m, p] of [['GET', '/api/subscription'], ['PUT', '/api/restaurant/custom-domain'], ['GET', '/api/restaurant/payments'], ['POST', '/api/paystack-connect/connect'], ['PATCH', '/api/restaurant'], ['GET', '/api/admin/stats']])
    assert.equal(staffRouteAllowed(branchMgr, m, p), false, `${m} ${p}`);
  assert.equal(staffRouteAllowed(branchMgr, 'GET', '/api/orders'), true); assert.equal(staffRouteAllowed(branchMgr, 'GET', '/api/restaurant'), true);
  assert.equal(staffRouteAllowed(custom, 'GET', '/api/menu/meals'), false); // no menu permission
  assert.equal(staffRouteAllowed(OWNER_ACCESS, 'PUT', '/api/restaurant/custom-domain'), true);
});
test('nobody can grant more than they hold', () => {
  const stafferMgr = buildAccess({ role: 'custom', perms: ['orders', 'staff'], branches: [A], allBranches: false });
  assert.equal(canGrant(stafferMgr, { role: 'custom', perms: ['orders'], branchIds: [A] }), true);
  assert.equal(canGrant(stafferMgr, { role: 'custom', perms: ['orders', 'menu'], branchIds: [A] }), false);   // menu not held
  assert.equal(canGrant(stafferMgr, { role: 'custom', perms: ['orders'], branchIds: [A, B] }), false);       // branch B not held
  assert.equal(canGrant(stafferMgr, { role: 'custom', perms: ['staff'], branchIds: [A] }), false);           // cannot hand out staff mgmt
  assert.equal(canGrant(stafferMgr, { role: 'all_branches_manager' }), false);
  assert.equal(canGrant(branchMgr, { role: 'custom', perms: ['orders'], branchIds: [A] }), false);           // no staff permission at all
  assert.equal(canGrant(OWNER_ACCESS, { role: 'all_branches_manager' }), true);
});

test('scopedQuery: a URL-supplied _id can never widen a branch manager beyond their branches', () => {
  const q = scopedQuery(branchMgr, 'R1', { _id: B }, '_id');
  assert.deepEqual(q, { restaurant: 'R1', $and: [{ _id: { $in: [A] } }, { _id: B }] }); // Mongo ANDs these: matches nothing for branch B
  assert.deepEqual(scopedQuery(allMgr, 'R1', { _id: B }, '_id'), { restaurant: 'R1', _id: B });
  assert.deepEqual(scopedQuery(OWNER_ACCESS, 'R1', { status: 'x' }), { restaurant: 'R1', status: 'x' });
});

/* ---------- <slug>.<platform domain> ---------- */
import { platformSubdomainSlug, restaurantUrl, restaurantBase, platformDomain } from '../src/services/domainUtils.js';
test('restaurant subdomains: only a single valid, non-reserved label under the platform domain is a restaurant', () => {
  process.env.PLATFORM_DOMAIN = 'ordarly.com.ng';
  assert.equal(platformDomain(), 'ordarly.com.ng');
  assert.equal(platformSubdomainSlug('foodhub.ordarly.com.ng'), 'foodhub');
  assert.equal(platformSubdomainSlug('Mama-Put.Ordarly.com.ng'), 'mama-put');
  for (const bad of ['ordarly.com.ng', 'www.ordarly.com.ng', 'api.ordarly.com.ng', 'app.ordarly.com.ng', 'a.b.ordarly.com.ng', '-x.ordarly.com.ng', 'x-.ordarly.com.ng', 'foodhub.evil.com', 'foodhub.ordarly.com.ng.evil.com', 'my_food.ordarly.com.ng'])
    assert.equal(platformSubdomainSlug(bad), null, bad);
});
test('restaurant links: custom domain first, then the subdomain when switched on, else the path URL', () => {
  process.env.PLATFORM_DOMAIN = 'ordarly.com.ng'; process.env.CLIENT_URL = 'https://ordarly.com.ng';
  const rest = { slug: 'foodhub', customDomain: 'foodhub.com' };
  delete process.env.WILDCARD_SUBDOMAINS;
  assert.equal(restaurantUrl(rest), 'https://ordarly.com.ng/foodhub');
  assert.equal(restaurantUrl(rest, { customDomainActive: true }), 'https://foodhub.com');
  process.env.WILDCARD_SUBDOMAINS = 'true';
  assert.equal(restaurantUrl(rest), 'https://foodhub.ordarly.com.ng');
  assert.equal(restaurantUrl(rest, { customDomainActive: true }), 'https://foodhub.com');
  assert.equal(restaurantBase(rest, { customDomainActive: false }), 'https://foodhub.ordarly.com.ng');
  delete process.env.WILDCARD_SUBDOMAINS;
  assert.equal(restaurantBase(rest, { customDomainActive: false }), 'https://ordarly.com.ng');
});
