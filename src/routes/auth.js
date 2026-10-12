import { placeDetails } from '../services/places.js';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { User, Restaurant } from '../models/index.js';
import { z, validate, wrap, sha256, randomToken, slugify, normalisePhone } from '../utils/helpers.js';
import { RESERVED_SLUGS, NIGERIAN_STATES } from '../config/plans.js';
import { signSession, setSessionCookie, requireAuth, COOKIE } from '../middleware/auth.js';
import { ensureSubscription } from '../services/subscription.js';
import { sendEmail, btn } from '../services/email.js';
import { getPlatformSettings } from '../services/settings.js';

const r = Router();
const client = () => process.env.CLIENT_URL;

const registerSchema = z.object({
  name: z.string().min(2).max(80),
  restaurantName: z.string().min(2).max(80),
  email: z.string().email(),
  phone: z.string().min(10).max(20),
  password: z.string().min(8).max(100),
  address: z.string().min(3).max(200), placeId: z.string().max(500).optional(), sessionToken: z.string().max(64).optional(),
  state: z.enum(NIGERIAN_STATES),
  slug: z.string().optional(),
});

async function uniqueSlug(base) {
  let s = slugify(base) || 'restaurant';
  if (RESERVED_SLUGS.has(s)) s += '-eats';
  let candidate = s, i = 1;
  while (await Restaurant.exists({ slug: candidate }) || RESERVED_SLUGS.has(candidate)) candidate = `${s}-${++i}`;
  return candidate;
}

r.post('/register', validate(registerSchema), wrap(async (req, res) => {
  const b = req.body;
  if (!(await getPlatformSettings()).registrationOpen) return res.status(403).json({ error: 'New sign-ups are paused right now. Please check back soon.' });
  if (await User.exists({ email: b.email.toLowerCase() })) return res.status(409).json({ error: 'Email already registered' });
  const verifyToken = randomToken();
  const user = await User.create({
    name: b.name, email: b.email, phone: b.phone,
    passwordHash: await bcrypt.hash(b.password, 12),
    role: 'owner', // never taken from the request
    verifyTokenHash: sha256(verifyToken),
  });
  const slug = await uniqueSlug(b.slug || b.restaurantName);
  let location;
  if (b.placeId) { try { const p = await placeDetails(b.placeId, b.sessionToken); location = { placeId: p.placeId, address: p.address, lat: p.lat, lng: p.lng }; } catch { /* typed address is still saved */ } }
  const rest = await Restaurant.create({
    owner: user._id, name: b.restaurantName, slug, phone: normalisePhone(b.phone),
    email: b.email, address: b.address, state: b.state, ...(location && { fulfillment: { location } }),
  });
  await ensureSubscription(rest._id);
  await sendEmail({
    to: user.email, type: 'verify_email', restaurant: rest._id,
    subject: 'Verify your email', body: `<p>Welcome, ${user.name}! Confirm your email to start taking orders.</p>${btn(`${client()}/verify-email?token=${verifyToken}`, 'Verify email')}`,
  });
  res.status(201).json({ ok: true, message: 'Account created. Check your email to verify.' });
}));

r.post('/verify-email', wrap(async (req, res) => {
  const token = String(req.body.token || '');
  const user = await User.findOne({ verifyTokenHash: sha256(token) }).select('+verifyTokenHash');
  if (!token || !user) return res.status(400).json({ error: 'Invalid or used link' });
  user.emailVerified = true; user.verifyTokenHash = undefined; await user.save();
  res.json({ ok: true });
}));

r.post('/login', validate(z.object({ email: z.string().email(), password: z.string().min(1) })), wrap(async (req, res) => {
  const user = await User.findOne({ email: req.body.email.toLowerCase() }).select('+passwordHash');
  const ok = user && (await bcrypt.compare(req.body.password, user.passwordHash));
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password' });
  if (user.status !== 'active') return res.status(403).json({ error: 'Account suspended' });
  if (!user.emailVerified && user.role !== 'admin') return res.status(403).json({ error: 'Please verify your email first', code: 'UNVERIFIED' });
  user.lastLoginAt = new Date(); await user.save();
  setSessionCookie(res, signSession(user));
  res.json({ ok: true, role: user.role });
}));

r.post('/logout', (req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });

r.post('/forgot-password', validate(z.object({ email: z.string().email() })), wrap(async (req, res) => {
  const user = await User.findOne({ email: req.body.email.toLowerCase() });
  if (user) {
    const t = randomToken();
    user.resetTokenHash = sha256(t); user.resetExpires = new Date(Date.now() + 3600000); await user.save();
    await sendEmail({ to: user.email, type: 'password_reset', subject: 'Reset your password',
      body: `<p>This link expires in 1 hour.</p>${btn(`${client()}/reset-password?token=${t}`, 'Reset password')}` });
  }
  res.json({ ok: true }); // same response either way: no account enumeration
}));

r.post('/reset-password', validate(z.object({ token: z.string(), password: z.string().min(8).max(100) })), wrap(async (req, res) => {
  const user = await User.findOne({ resetTokenHash: sha256(req.body.token), resetExpires: { $gt: new Date() } }).select('+resetTokenHash +resetExpires');
  if (!user) return res.status(400).json({ error: 'Invalid or expired link' });
  user.passwordHash = await bcrypt.hash(req.body.password, 12);
  user.resetTokenHash = undefined; user.resetExpires = undefined; await user.save();
  await sendEmail({ to: user.email, type: 'password_changed', subject: 'Your password was changed', body: '<p>If this was not you, contact support immediately.</p>' });
  res.json({ ok: true });
}));

r.get('/me', requireAuth, wrap(async (req, res) => {
  const rest = await Restaurant.findOne({ owner: req.user._id }).select('name slug plan status');
  res.json({ user: { name: req.user.name, email: req.user.email, role: req.user.role }, restaurant: rest });
}));

export default r;
