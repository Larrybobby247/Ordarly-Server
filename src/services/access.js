// Role-based access for restaurant staff. Pure functions (unit-tested); the middleware in middleware/auth.js applies them.
export const PERMS = ['orders', 'menu', 'analytics', 'branches', 'staff'];
export const ROLES = ['branch_manager', 'all_branches_manager', 'custom'];

/** What each role means. `custom` takes whatever the owner ticked. */
export const ROLE_PRESETS = {
  branch_manager: { perms: ['orders', 'menu', 'analytics'], allBranches: false },
  all_branches_manager: { perms: ['orders', 'menu', 'analytics', 'branches'], allBranches: true },
  custom: { perms: [], allBranches: false },
};

export const OWNER_ACCESS = Object.freeze({ isOwner: true, role: 'owner', allBranches: true, branchIds: [], perms: new Set([...PERMS, 'settings']) });

/** Turn a StaffMember record into the access object used on every request. */
export function buildAccess(staff) {
  const preset = ROLE_PRESETS[staff.role] || ROLE_PRESETS.custom;
  const perms = new Set((staff.role === 'custom' ? staff.perms : preset.perms).filter((p) => PERMS.includes(p)));
  const allBranches = staff.role === 'custom' ? !!staff.allBranches : preset.allBranches;
  return { isOwner: false, role: staff.role, allBranches, branchIds: (staff.branches || []).map(String), perms };
}

export const can = (access, perm) => !!access && (access.isOwner || access.perms.has(perm));
export const canBranch = (access, branchId) => !!access && (access.isOwner || access.allBranches || access.branchIds.includes(String(branchId)));

/** Mongo filter that limits a query to the branches this person may see. `field` is the branch field name. */
export function branchFilter(access, field = 'branch') {
  if (!access || access.isOwner || access.allBranches) return {};
  return { [field]: { $in: access.branchIds } }; // orders with no branch (legacy/main) are not visible to single-branch managers
}

/**
 * Can `granter` give someone this access? Owners can give anything. Anyone else can only hand out a subset of their own
 * permissions and branches, and never the staff permission itself, so nobody can escalate.
 */
export function canGrant(granter, { role, perms = [], branchIds = [], allBranches = false }) {
  if (granter.isOwner) return true;
  if (!granter.perms.has('staff')) return false;
  const want = new Set(role === 'custom' ? perms : ROLE_PRESETS[role]?.perms || []);
  if (want.has('staff')) return false;
  for (const p of want) if (!granter.perms.has(p)) return false;
  const all = role === 'custom' ? allBranches : ROLE_PRESETS[role]?.allBranches;
  if (all && !granter.allBranches) return false;
  if (!all && !granter.allBranches && !branchIds.every((b) => granter.branchIds.includes(String(b)))) return false;
  return true;
}

/** Routes a staff member may ever reach (default-deny for everything else). Owner-only areas are simply not listed. */
export const STAFF_ROUTES = [
  { prefix: '/api/orders', perm: 'orders' },
  { prefix: '/api/menu', perm: 'menu' },
  { prefix: '/api/earnings', perm: 'analytics' },
  { prefix: '/api/branches', perm: null },          // per-handler checks (view vs manage)
  { prefix: '/api/staff', perm: 'staff' },
  { prefix: '/api/uploads', perm: 'menu' },
  { prefix: '/api/restaurant/analytics', perm: 'analytics' },
  { prefix: '/api/restaurant', perm: null, exact: true }, // GET only: layout needs the restaurant name/plan
];

export function staffRouteAllowed(access, method, path) {
  if (!access || access.isOwner) return true;
  const hit = STAFF_ROUTES.find((r) => (r.exact ? path === r.prefix || path === r.prefix + '/' : path === r.prefix || path.startsWith(r.prefix + '/')));
  if (!hit) return false;
  if (hit.exact && method !== 'GET') return false;
  return hit.perm ? access.perms.has(hit.perm) : true;
}

/**
 * Build a query that is limited to the restaurant AND the caller's branches, and ALSO matches `extra`.
 * `field` is the branch field for that collection ('_id' on Branch itself, 'branch' elsewhere). Uses $and so that `extra`
 * can never overwrite the branch restriction (e.g. both mention _id).
 */
export function scopedQuery(access, restaurantId, extra = {}, field = 'branch') {
  const bf = branchFilter(access, field);
  return Object.keys(bf).length ? { restaurant: restaurantId, $and: [bf, extra] } : { restaurant: restaurantId, ...extra };
}
