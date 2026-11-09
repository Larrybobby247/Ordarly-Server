import { Router } from 'express';
import mongoose from 'mongoose';
import { LedgerEntry, Branch } from '../models/index.js';
import { wrap } from '../utils/helpers.js';
import { requireAuth, loadRestaurant, requirePerm } from '../middleware/auth.js';
import { branchFilter, canBranch } from '../services/access.js';
import { earningsSummary } from '../services/ledger.js';
import { rangeBounds } from '../services/tz.js';
import { tzOf } from '../services/tz.js';

const r = Router();
r.use(requireAuth, loadRestaurant, requirePerm('analytics'));

/** Branch + date filters shared by both endpoints. Every figure comes from LedgerEntry rows, never from anything the browser sends as money. */
function filters(req) {
  const tz = tzOf(req.restaurant);
  const range = req.query.range || '30d';
  const bounds = rangeBounds(range, { tz, from: req.query.from, to: req.query.to });
  if (range === 'custom' && !bounds) return { error: 'Choose a valid start and end date.' };
  const branchMatch = { ...branchFilter(req.access) }; // staff: only their branches
  const only = req.query.branch;
  if (only === 'main') { if (!req.access.isOwner && !req.access.allBranches) return { error: 'You do not have access to that branch.', status: 403 }; branchMatch.branch = null; }
  else if (only) {
    if (!mongoose.isValidObjectId(only) || !canBranch(req.access, only)) return { error: 'You do not have access to that branch.', status: 403 };
    branchMatch.branch = new mongoose.Types.ObjectId(only);
  }
  return { tz, range, bounds, branchMatch };
}

r.get('/', wrap(async (req, res) => {
  const f = filters(req); if (f.error) return res.status(f.status || 400).json({ error: f.error });
  const [summary, branches] = await Promise.all([
    earningsSummary({ restaurant: req.restaurant._id, branchMatch: f.branchMatch, range: f.bounds }),
    Branch.find({ restaurant: req.restaurant._id }).select('name').lean(),
  ]);
  const names = new Map(branches.map((b) => [String(b._id), b.name]));
  summary.byBranch = summary.byBranch.map((b) => ({ ...b, branchName: b.branch ? names.get(String(b.branch)) || 'Removed branch' : 'Main (no branch)' }));
  res.json({
    plan: req.plan, commissionPct: req.planConfig[req.plan]?.commissionPct ?? 0, timezone: f.tz, range: f.range,
    from: f.bounds?.from || null, to: f.bounds?.to || null, ...summary,
    // The headline for Free restaurants: what is left after Ordarly's commission (gateway fees are shown separately).
    totalEarningsAfterCommission: summary.netEarnings,
  });
}));

r.get('/transactions', wrap(async (req, res) => {
  const f = filters(req); if (f.error) return res.status(f.status || 400).json({ error: f.error });
  const q = { restaurant: req.restaurant._id, ...f.branchMatch, ...(f.bounds ? { eventAt: { $gte: f.bounds.from, $lt: f.bounds.to } } : {}) };
  if (['held', 'earned', 'reversed'].includes(req.query.status)) q.status = req.query.status;
  const page = Math.max(1, Number(req.query.page) || 1), limit = 25;
  const [rows, total, branches] = await Promise.all([
    LedgerEntry.find(q).sort('-eventAt').skip((page - 1) * limit).limit(limit).lean(),
    LedgerEntry.countDocuments(q),
    Branch.find({ restaurant: req.restaurant._id }).select('name').lean(),
  ]);
  const names = new Map(branches.map((b) => [String(b._id), b.name]));
  res.json({
    total, page, pages: Math.ceil(total / limit),
    rows: rows.map((e) => ({
      id: e._id, order: e.order, orderRef: e.orderRef, date: e.eventAt, status: e.status, branch: e.branch ? names.get(String(e.branch)) || 'Removed branch' : null,
      paymentMethod: e.paymentMethod, mealSubtotal: e.mealSubtotal, deliveryFee: e.deliveryFee, commissionPct: e.commissionPct, commission: e.commission,
      gatewayFee: e.gatewayFee, refunded: e.refunded, net: e.net, legacy: !!e.legacy,
    })),
  });
}));

export default r;
