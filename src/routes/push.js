import { Router } from 'express';
import { PushSubscription } from '../models/index.js';
import { z, validate, wrap } from '../utils/helpers.js';
import { requireAuth, requireRole, loadRestaurant } from '../middleware/auth.js';
import { pushConfigured, vapidPublicKey, notifyRestaurant } from '../services/notify.js';

const r = Router();
r.use(requireAuth, requireRole('owner'), loadRestaurant);

r.get('/key', (req, res) => res.json({ enabled: pushConfigured(), publicKey: vapidPublicKey() }));

const subSchema = z.object({ subscription: z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }) });
r.post('/subscribe', validate(subSchema), wrap(async (req, res) => {
  const { endpoint, keys } = req.body.subscription;
  if (!/^https:\/\//.test(endpoint)) return res.status(400).json({ error: 'Invalid subscription' });
  await PushSubscription.findOneAndUpdate({ endpoint }, { user: req.user._id, restaurant: req.restaurant._id, keys, userAgent: String(req.headers['user-agent'] || '').slice(0, 200) }, { upsert: true, new: true });
  res.json({ ok: true });
}));

r.post('/unsubscribe', validate(z.object({ endpoint: z.string().max(1000) })), wrap(async (req, res) => {
  await PushSubscription.deleteOne({ endpoint: req.body.endpoint, user: req.user._id });
  res.json({ ok: true });
}));

r.post('/test', wrap(async (req, res) => {
  await notifyRestaurant(req.restaurant._id, { title: 'Notifications are on', body: 'You will be alerted here when new orders and messages arrive.', url: '/dashboard', tag: 'test' });
  res.json({ ok: true });
}));

export default r;
