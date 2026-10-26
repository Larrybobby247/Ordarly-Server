import jwt from 'jsonwebtoken';
import { User, Restaurant, Subscription } from '../models/index.js';
import { getPlanConfig } from '../services/settings.js';
import { isProActive } from '../services/subscription.js';

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

export const requireRole = (role) => (req, res, next) =>
  req.user?.role === role ? next() : res.status(403).json({ error: 'Forbidden' });

/** Loads the caller's OWN restaurant — tenant isolation: ids are never taken from the client. */
export async function loadRestaurant(req, res, next) {
  const r = await Restaurant.findOne({ owner: req.user._id });
  if (!r) return res.status(404).json({ error: 'No restaurant on this account' });
  if (r.status === 'suspended') return res.status(403).json({ error: 'Restaurant suspended', reason: r.suspendReason });
  const sub = await Subscription.findOne({ restaurant: r._id });
  req.restaurant = r;
  req.subscription = sub;
  req.isPro = isProActive(sub);
  // Self-heal denormalised plan field if cron hasn't run yet
  const plan = req.isPro ? 'pro' : 'free';
  if (r.plan !== plan) { r.plan = plan; await r.save(); }
  req.planConfig = await getPlanConfig();
  next();
}

/** Backend plan enforcement. */
export const requirePro = (feature) => (req, res, next) =>
  req.isPro ? next() : res.status(402).json({ error: `${feature || 'This feature'} requires the Pro plan`, code: 'PRO_REQUIRED' });
