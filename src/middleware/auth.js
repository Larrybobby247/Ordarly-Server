import jwt from 'jsonwebtoken';
import { User, Restaurant, Subscription, StaffMember } from '../models/index.js';
import { getPlanConfig } from '../services/settings.js';
import { isProActive, planOf } from '../services/subscription.js';
import { OWNER_ACCESS, buildAccess, can, staffRouteAllowed } from '../services/access.js';

export const COOKIE = 'orderly_session';

export function signSession(user) {
  return jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax', 
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 7 * 86400000,
  });
}

/** Loads user from the cookie. Role always comes from the DB, never from the request. */
export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token) return res.status(401).json({ error: 'Not signed in' });
    const { sub } = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(sub);
    if (!user || user.status !== 'active') return res.status(401).json({ error: 'Account unavailable' });
    req.user = user;
    next();
  } catch { res.status(401).json({ error: 'Session expired' }); }
}

/** Same as requireAuth but never rejects: resolves the signed-in user or null (used where a page works signed-in or not). */
export async function optionalUser(req) {
  try {
    const token = req.cookies?.[COOKIE]; if (!token) return null;
    const { sub } = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(sub);
    return user && user.status === 'active' ? user : null;
  } catch { return null; }
}

export const requireRole = (role) => (req, res, next) =>
  req.user?.role === role ? next() : res.status(403).json({ error: 'Forbidden' });

/**
 * Loads the restaurant the caller works for and what they are allowed to do in it.
 *  - An owner gets their OWN restaurant with full access.
 *  - Invited staff get the restaurant that invited them, with the access that was granted (req.access), and may only reach the
 *    routes in STAFF_ROUTES (default-deny). Ids are never taken from the client.
 */
export async function loadRestaurant(req, res, next) {
  try {
    let r = await Restaurant.findOne({ owner: req.user._id });
    let access = OWNER_ACCESS;
    if (!r) {
      const staff = req.user.role === 'staff' ? await StaffMember.findOne({ user: req.user._id, status: 'active' }) : null;
      r = staff && (await Restaurant.findById(staff.restaurant));
      if (!r) return res.status(404).json({ error: 'No restaurant on this account' });
      access = buildAccess(staff);
    }
    if (r.status === 'suspended') return res.status(403).json({ error: 'Restaurant suspended', reason: r.suspendReason });
    const sub = await Subscription.findOne({ restaurant: r._id });
    req.restaurant = r;
    req.subscription = sub;
    req.isPro = isProActive(sub);
    req.plan = planOf(sub);
    req.isBusiness = req.plan === 'business';
    req.access = access;
    // Self-heal denormalised plan field if cron hasn't run yet
    if (r.plan !== req.plan) { r.plan = req.plan; await r.save(); }
    if (!access.isOwner) {
      if (!req.isBusiness) return res.status(403).json({ error: 'Staff access is paused because the restaurant is not on an active Business plan.', code: 'STAFF_PLAN' });
      if (!staffRouteAllowed(access, req.method, req.originalUrl.split('?')[0].replace(/\/+$/, '') || '/')) return res.status(403).json({ error: 'You do not have access to this area.', code: 'FORBIDDEN' });
    }
    req.planConfig = await getPlanConfig();
    next();
  } catch (e) { next(e); }
}

/** Per-handler permission check (the route allowlist only decides which areas exist for staff at all). */
export const requirePerm = (perm) => (req, res, next) => (can(req.access, perm) ? next() : res.status(403).json({ error: 'You do not have permission to do this.', code: 'FORBIDDEN' }));
/** Owner-only actions inside areas staff can otherwise enter. */
export const requireOwner = (req, res, next) => (req.access?.isOwner ? next() : res.status(403).json({ error: 'Only the account owner can do this.', code: 'FORBIDDEN' }));
/** Shared (restaurant-wide) settings can only be changed by someone with access to every branch. */
export const requireAllBranches = (req, res, next) => ((req.access?.isOwner || req.access?.allBranches) ? next() : res.status(403).json({ error: 'Only someone with access to every branch can change the shared menu. Use your branch menu instead.', code: 'FORBIDDEN' }));
export const requireBusiness = (feature) => (req, res, next) => (req.isBusiness ? next() : res.status(402).json({ error: `${feature || 'This feature'} requires the Business plan`, code: 'BUSINESS_REQUIRED' }));

/** Backend plan enforcement. */
export const requirePro = (feature) => (req, res, next) =>
  req.isPro ? next() : res.status(402).json({ error: `${feature || 'This feature'} requires the Pro plan`, code: 'PRO_REQUIRED' });
