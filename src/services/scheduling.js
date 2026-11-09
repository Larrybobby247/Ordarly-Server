// Database side of scheduled orders: slot capacity, abandoned-slot cleanup and reminders.
import { Order, SlotBooking, Restaurant, Branch } from '../models/index.js';
import { schedulingOf } from './schedule.js';
import { tzOf, formatLocal } from './tz.js';
import { notifyRestaurant } from './notify.js';
import { sendEmail, btn } from './email.js';
import { ACTIONABLE } from '../config/plans.js';

/** { [slotStartISO]: count } for one restaurant/branch between two instants. */
export async function bookedCounts(restaurant, branch, from, to) {
  const rows = await SlotBooking.find({ restaurant, branch: branch || null, slotStart: { $gte: from, $lt: to } }).select('slotStart count').lean();
  return Object.fromEntries(rows.map((r) => [r.slotStart.toISOString(), r.count]));
}

/** Atomically take one place in a slot. Returns false when the slot is full (the unique index makes the loser of a race fail cleanly). */
export async function reserveSlot(restaurant, branch, slotStart, capacity) {
  if (!capacity || capacity <= 0) return true; // unlimited
  try {
    const r = await SlotBooking.findOneAndUpdate({ restaurant, branch: branch || null, slotStart, count: { $lt: capacity } }, { $inc: { count: 1 } }, { upsert: true, new: true });
    return !!r;
  } catch (e) { if (e?.code === 11000) return false; throw e; }
}

/** Give a place back by slot (used when an order could not be created at all). */
export const releaseSlotRaw = (restaurant, branch, slotStart) => SlotBooking.updateOne({ restaurant, branch: branch || null, slotStart, count: { $gt: 0 } }, { $inc: { count: -1 } });

/** Give the place back (cancelled or never paid). Only once per order. */
export async function releaseSlot(order) {
  if (!order?.isScheduled || !order.scheduledFor) return;
  const claimed = await Order.findOneAndUpdate({ _id: order._id, slotReleased: { $ne: true } }, { slotReleased: true });
  if (!claimed) return;
  await SlotBooking.updateOne({ restaurant: order.restaurant, branch: order.branch || null, slotStart: order.scheduledFor, count: { $gt: 0 } }, { $inc: { count: -1 } });
}

const FIFTEEN_MIN = 15 * 60000;

/**
 * Cron (every minute).
 *  1. Online orders that were never paid within an hour give their slot back.
 *  2. The restaurant is reminded once, `reminderMinutes` before each scheduled order that is ready to be acted on.
 */
export async function runSchedulingJobs(now = new Date()) {
  const abandoned = await Order.find({ isScheduled: true, slotReleased: { $ne: true }, paymentMethod: 'paystack', paymentStatus: { $in: ['awaiting_payment', 'pending', 'failed'] }, createdAt: { $lt: new Date(+now - 60 * 60000) }, status: { $nin: ['cancelled', 'completed'] } }).limit(100);
  for (const o of abandoned) await releaseSlot(o);

  const due = await Order.find({ isScheduled: true, reminderSentAt: { $exists: false }, status: { $nin: ['completed', 'cancelled'] }, scheduledFor: { $gt: new Date(+now - FIFTEEN_MIN), $lte: new Date(+now + 180 * 60000) }, ...ACTIONABLE }).limit(100);
  let sent = 0;
  const cache = new Map();
  for (const o of due) {
    const key = String(o.restaurant);
    if (!cache.has(key)) cache.set(key, await Restaurant.findById(o.restaurant).select('name email scheduling').lean());
    const rest = cache.get(key); if (!rest) continue;
    const lead = schedulingOf(rest).reminderMinutes * 60000;
    if (+o.scheduledFor - lead > +now) continue; // not time yet
    const claimed = await Order.findOneAndUpdate({ _id: o._id, reminderSentAt: { $exists: false } }, { reminderSentAt: now });
    if (!claimed) continue; // another run got it
    const when = formatLocal(o.scheduledFor, tzOf(rest));
    const where = o.branchName ? ` · ${o.branchName}` : '';
    sent++;
    notifyRestaurant(o.restaurant, { title: 'Scheduled order coming up', body: `${o.reference} is due ${when}${where}`, url: '/dashboard/orders', tag: `sched-${o._id}` });
    sendEmail({ to: rest.email, type: 'scheduled_reminder', restaurant: o.restaurant, order: o._id, dedupeKey: `sched-rem:${o._id}`,
      subject: `Reminder: scheduled order ${o.reference} is due ${when}`, body: `<p>Order <b>${o.reference}</b>${o.branchName ? ` for <b>${o.branchName}</b>` : ''} is scheduled for <b>${when}</b>. Start preparing it in time.</p>${btn(`${process.env.CLIENT_URL}/dashboard/orders`, 'Open orders')}` }).catch(() => {});
  }
  return { released: abandoned.length, reminded: sent };
}
