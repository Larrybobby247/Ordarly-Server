import { Router } from 'express';
import mongoose from 'mongoose';
import { Branch, BranchMealOverride, Meal, Order, LedgerEntry } from '../models/index.js';
import { z, validate, wrap, normalisePhone } from '../utils/helpers.js';
import { requireAuth, loadRestaurant, requirePerm, requireBusiness } from '../middleware/auth.js';
import { branchFilter, canBranch, scopedQuery } from '../services/access.js';
import { clearCacheOnWrite } from '../services/publicCache.js';
import { canAddBranch } from '../services/branches.js';
import { autocomplete, placeDetails } from '../services/places.js';
import { earningsSummary } from '../services/ledger.js';
import { rangeBounds, tzOf } from '../services/tz.js';

const r = Router();
r.use(requireAuth, loadRestaurant, requireBusiness('Branches'));
r.use(clearCacheOnWrite);

// A person who may only manage some branches never sees (or changes) the others: every lookup goes through this.
const mine = (req, extra = {}) => scopedQuery(req.access, req.restaurant._id, extra, '_id');
const needAllBranches = (req, res, next) => ((req.access.isOwner || req.access.allBranches) ? next() : res.status(403).json({ error: 'Only someone with access to every branch can do this.', code: 'FORBIDDEN' }));
const idOk = (req, res, next) => (mongoose.isValidObjectId(req.params.id) ? next() : res.status(404).json({ error: 'Branch not found' }));

const hours = z.array(z.object({ day: z.number().int().min(0).max(6), open: z.string().regex(/^\d{2}:\d{2}$/), close: z.string().regex(/^\d{2}:\d{2}$/), closed: z.boolean().optional() })).max(7);
const branchSchema = z.object({
  name: z.string().min(2).max(80),
  address: z.string().max(300).optional(), placeId: z.string().max(2000).optional(), sessionToken: z.string().max(64).optional(),
  phone: z.string().max(20).optional(), whatsapp: z.string().max(20).optional(),
  openingHours: hours.optional(), acceptingOrders: z.boolean().optional(),
  prepTimeMinutes: z.number().int().min(0).max(600).nullable().optional(),
  fulfillment: z.object({
    pickupEnabled: z.boolean(), dineInEnabled: z.boolean(), deliveryEnabled: z.boolean(), pickupInstructions: z.string().max(300),
    radius: z.object({ baseFee: z.number().min(0).max(100000), baseDistanceKm: z.number().min(0.5).max(50), perKmRate: z.number().min(0).max(100000), maxRadiusKm: z.number().min(1).max(100) }),
  }).partial().optional(),
});

async function applyBranchBody(branch, b) {
  const { placeId, sessionToken, fulfillment, ...plain } = b;
  if (plain.phone !== undefined) plain.phone = normalisePhone(plain.phone);
  if (plain.whatsapp !== undefined) plain.whatsapp = normalisePhone(plain.whatsapp);
  Object.assign(branch, plain);
  if (placeId) { const p = await placeDetails(placeId, sessionToken); branch.location = { placeId: p.placeId, address: p.address, lat: p.lat, lng: p.lng }; if (!plain.address) branch.address = p.address; }
  if (fulfillment) {
    const { radius, ...flags } = fulfillment;
    Object.assign(branch.fulfillment, flags);
    if (radius) branch.fulfillment.radius = { ...radius, configured: true };
    branch.markModified('fulfillment');
  }
  if (branch.fulfillment?.deliveryEnabled && !(branch.fulfillment.radius?.configured && branch.location?.lat != null)) {
    const e = new Error('To turn delivery on, search for the branch address and set its delivery fee and radius first.'); e.status = 400; throw e;
  }
}

r.get('/', requirePerm('branches'), wrap(async (req, res) => {
  const branches = await Branch.find(mine(req)).sort('sort name').lean();
  const limit = await canAddBranch(req.planConfig, req.restaurant._id);
  res.json({ branches, limit: { have: limit.have, max: limit.max, canAdd: limit.ok && (req.access.isOwner || req.access.allBranches) } });
}));

r.post('/places/autocomplete', requirePerm('branches'), validate(z.object({ input: z.string().min(3).max(120), sessionToken: z.string().max(64).optional() })), wrap(async (req, res) => {
  res.json({ suggestions: await autocomplete(req.body.input, { sessionToken: req.body.sessionToken }) });
}));

r.post('/', requirePerm('branches'), needAllBranches, validate(branchSchema), wrap(async (req, res) => {
  const lim = await canAddBranch(req.planConfig, req.restaurant._id);
  if (!lim.ok) return res.status(409).json({ error: `Your plan allows up to ${lim.max} branch${lim.max === 1 ? '' : 'es'}. Contact Ordarly to raise the limit.`, code: 'BRANCH_LIMIT' });
  const branch = new Branch({ restaurant: req.restaurant._id, name: req.body.name });
  try { await applyBranchBody(branch, req.body); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  await branch.save();
  res.status(201).json({ branch });
}));

r.patch('/:id', idOk, requirePerm('branches'), validate(branchSchema.partial()), wrap(async (req, res) => {
  const branch = await Branch.findOne(mine(req, { _id: req.params.id }));
  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  try { await applyBranchBody(branch, req.body); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  await branch.save();
  res.json({ branch });
}));

// Activate / deactivate. Deactivated branches disappear from the customer picker; their history stays.
r.post('/:id/status', idOk, requirePerm('branches'), validate(z.object({ status: z.enum(['active', 'inactive']) })), wrap(async (req, res) => {
  const branch = await Branch.findOne(mine(req, { _id: req.params.id }));
  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  branch.status = req.body.status; await branch.save();
  res.json({ branch });
}));

/* ---------- Per-branch menu: availability and price differences on top of the shared menu ---------- */
r.get('/:id/menu', idOk, requirePerm('menu'), wrap(async (req, res) => {
  const branch = await Branch.findOne(mine(req, { _id: req.params.id })).select('_id name');
  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  const [meals, ovs] = await Promise.all([Meal.find({ restaurant: req.restaurant._id }).sort('name').select('name price available image category sizes').lean(), BranchMealOverride.find({ branch: branch._id }).lean()]);
  const map = new Map(ovs.map((o) => [String(o.meal), o]));
  res.json({ branch: { _id: branch._id, name: branch.name }, meals: meals.map((m) => ({ ...m, override: map.get(String(m._id)) || null })) });
}));

const overrideSchema = z.object({
  available: z.boolean().nullable().optional(), price: z.number().min(0).max(10_000_000).nullable().optional(),
  sizes: z.array(z.object({ sizeId: z.string().max(40), price: z.number().min(0).max(10_000_000).nullable().optional(), available: z.boolean().nullable().optional() })).max(12).optional(),
});
r.put('/:id/menu/:mealId', idOk, requirePerm('menu'), validate(overrideSchema), wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.mealId)) return res.status(404).json({ error: 'Meal not found' });
  const [branch, meal] = await Promise.all([Branch.findOne(mine(req, { _id: req.params.id })).select('_id'), Meal.findOne({ _id: req.params.mealId, restaurant: req.restaurant._id }).select('_id sizes')]);
  if (!branch || !meal) return res.status(404).json({ error: 'Not found' });
  const validSizes = new Set((meal.sizes || []).map((z) => String(z._id)));
  const sizes = (req.body.sizes || []).filter((z) => validSizes.has(z.sizeId) && (z.price != null || z.available != null));
  const doc = { available: req.body.available ?? null, price: req.body.price ?? null, sizes };
  const empty = doc.available === null && doc.price === null && !sizes.length;
  if (empty) { await BranchMealOverride.deleteOne({ branch: branch._id, meal: meal._id }); return res.json({ override: null }); }
  const override = await BranchMealOverride.findOneAndUpdate({ branch: branch._id, meal: meal._id }, { $set: { restaurant: req.restaurant._id, ...doc } }, { upsert: true, new: true });
  res.json({ override });
}));

/* ---------- Branch dashboard: counts and earnings for one branch ---------- */
r.get('/:id/overview', idOk, requirePerm('analytics'), wrap(async (req, res) => {
  const branch = await Branch.findOne(mine(req, { _id: req.params.id })).lean();
  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  const tz = tzOf(req.restaurant);
  const [today, last30, earnings] = await Promise.all([
    Order.countDocuments({ restaurant: req.restaurant._id, branch: branch._id, createdAt: { $gte: rangeBounds('today', { tz }).from } }),
    Order.aggregate([{ $match: { restaurant: req.restaurant._id, branch: branch._id, createdAt: { $gte: rangeBounds('30d', { tz }).from } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    earningsSummary({ restaurant: req.restaurant._id, branchMatch: { branch: branch._id }, range: rangeBounds('30d', { tz }) }),
  ]);
  res.json({ branch, ordersToday: today, last30DaysByStatus: Object.fromEntries(last30.map((x) => [x._id, x.n])), earnings });
}));

export default r;
