// Branch helpers: what a branch changes about the restaurant, menu overrides, and plan limits.
import { Branch, BranchMealOverride } from '../models/index.js';

export const activeBranches = (restaurantId) => Branch.find({ restaurant: restaurantId, status: 'active' }).sort('sort name').lean();

/**
 * The restaurant "as seen from" one branch. Every existing helper that reads rest.openingHours, rest.fulfillment, rest.phone...
 * (opening status, delivery quotes, pickup address) works unchanged when given this object, so a branch can never fall back to
 * another location's delivery settings by accident: delivery needs the branch's OWN location and radius.
 */
export function effectiveRestaurant(rest, branch) {
  const base = rest?.toObject ? rest.toObject() : { ...rest };
  if (!branch) return base;
  const bf = branch.fulfillment || {};
  return {
    ...base,
    branchId: String(branch._id), branchName: branch.name,
    phone: branch.phone || base.phone, whatsapp: branch.whatsapp || base.whatsapp, address: branch.address || base.address,
    openingHours: branch.openingHours?.length ? branch.openingHours : base.openingHours,
    acceptingOrders: base.acceptingOrders !== false && branch.acceptingOrders !== false,
    prepTimeMinutes: branch.prepTimeMinutes ?? null,
    fulfillment: {
      ...(base.fulfillment || {}),
      pickupEnabled: bf.pickupEnabled !== false, dineInEnabled: !!bf.dineInEnabled, deliveryEnabled: !!bf.deliveryEnabled,
      pickupInstructions: bf.pickupInstructions || '',
      location: branch.location?.lat != null ? branch.location : undefined,
      radius: bf.radius || { configured: false },
    },
  };
}

/** Apply one branch's difference to one meal. Overrides can only make things unavailable or change a price, never un-sell a globally sold-out item. */
export function applyOverride(meal, ov) {
  if (!ov) return meal;
  const out = { ...meal };
  if (ov.available === false) out.available = false;
  if (meal.sizes?.length) {
    out.sizes = meal.sizes.map((z) => {
      const o = (ov.sizes || []).find((x) => String(x.sizeId) === String(z._id));
      if (!o) return z;
      return { ...z, price: o.price ?? z.price, available: z.available !== false && o.available !== false };
    });
    const open = out.sizes.filter((z) => z.available !== false);
    if (open.length) out.price = Math.min(...open.map((z) => z.price));
  } else if (ov.price != null) out.price = ov.price;
  return out;
}

export async function overrideMap(branchId) {
  if (!branchId) return new Map();
  const rows = await BranchMealOverride.find({ branch: branchId }).lean();
  return new Map(rows.map((o) => [String(o.meal), o]));
}

/** May this restaurant add another branch? Limit comes from the live plan config (admin-editable), never from code. */
export async function canAddBranch(cfg, restaurantId) {
  const max = Number(cfg?.business?.maxBranches) || 0;
  const have = await Branch.countDocuments({ restaurant: restaurantId });
  return { ok: have < max, have, max };
}
