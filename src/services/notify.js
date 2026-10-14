// Web Push (device notifications) for restaurant owners. Needs VAPID keys; without them every call is a quiet no-op.
// Generate keys once with:  npx web-push generate-vapid-keys
import { PushSubscription } from '../models/index.js';

let lib; // loaded lazily so the server still starts if the package is not installed yet
async function wp() {
  if (lib !== undefined) return lib;
  try {
    const m = (await import('web-push')).default;
    m.setVapidDetails(process.env.VAPID_SUBJECT || `mailto:${process.env.EMAIL_FROM_ADDRESS || 'support@example.com'}`, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    lib = m;
  } catch (e) { console.error('[push] web-push unavailable:', e.message); lib = null; }
  return lib;
}

export const pushConfigured = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY || '';

/** Send to every device of a restaurant's owner. Never throws: a failed notification must never break an order. */
export async function notifyRestaurant(restaurantId, { title, body, url = '/dashboard', tag }) {
  try {
    if (!pushConfigured()) return;
    const subs = await PushSubscription.find({ restaurant: restaurantId }).lean();
    if (!subs.length) return;
    const w = await wp(); if (!w) return;
    const payload = JSON.stringify({ title, body, url, tag });
    await Promise.all(subs.map(async (s) => {
      try { await w.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 3600, urgency: 'high' }); }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await PushSubscription.deleteOne({ _id: s._id }); }
    }));
  } catch (e) { console.error('[push]', e.message); }
}
