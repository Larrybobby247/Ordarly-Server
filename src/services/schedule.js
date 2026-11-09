// Scheduled ("order for later") availability. Pure functions: the database parts live in services/scheduling.js.
import { localDay, zonedToUtc, addLocalDays, startOfLocalDay, DEFAULT_TZ } from './tz.js';

export const DEFAULT_SCHEDULING = { enabled: false, maxDaysAhead: 7, minNoticeMinutes: 60, slotMinutes: 30, capacityPerSlot: 0, reminderMinutes: 60, timezone: DEFAULT_TZ };
export const schedulingOf = (rest) => ({ ...DEFAULT_SCHEDULING, ...(rest?.scheduling?.toObject ? rest.scheduling.toObject() : rest?.scheduling || {}) });

const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
const DEFAULT_OPEN = '08:00', DEFAULT_CLOSE = '21:00'; // used only when a restaurant never set opening hours

/**
 * Slots for one local calendar day.
 *   hours: the EFFECTIVE opening hours (branch hours if set, otherwise the restaurant's)
 *   booked: { [slotStartISO]: count }
 * Returns [] for dates in the past, beyond the booking window, or closed days.
 */
export function generateSlots({ dateStr, hours = [], cfg = DEFAULT_SCHEDULING, now = new Date(), booked = {}, acceptingOrders = true }) {
  if (!acceptingOrders || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return [];
  const tz = cfg.timezone || DEFAULT_TZ;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dayStart = zonedToUtc(y, m, d, 0, 0, tz);
  if (localDay(dayStart, tz).ymd !== dateStr) return []; // e.g. 2025-02-31
  if (dayStart < startOfLocalDay(now, tz)) return [];  // never the past
  const lastDay = addLocalDays(now, cfg.maxDaysAhead, tz);
  if (dayStart > lastDay) return [];

  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const h = hours?.length ? hours.find((x) => x.day === dow) : { open: DEFAULT_OPEN, close: DEFAULT_CLOSE };
  if (!h || h.closed || !h.open || !h.close) return [];
  const open = toMin(h.open), close = toMin(h.close), step = Math.max(5, Number(cfg.slotMinutes) || 30);
  if (close <= open) return [];

  const earliest = +now + Math.max(0, cfg.minNoticeMinutes) * 60000;
  const slots = [];
  for (let t = open; t + step <= close; t += step) {
    const start = zonedToUtc(y, m, d, Math.floor(t / 60), t % 60, tz);
    const iso = start.toISOString();
    const count = booked[iso] || 0;
    const full = cfg.capacityPerSlot > 0 && count >= cfg.capacityPerSlot;
    const tooSoon = +start < earliest;
    slots.push({ start: iso, time: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`, available: !full && !tooSoon, reason: full ? 'full' : tooSoon ? 'too_soon' : undefined });
  }
  return slots;
}

/** The days a customer may pick from (only days that still have at least one open slot are worth listing; the caller decides). */
export function candidateDates({ cfg = DEFAULT_SCHEDULING, now = new Date() }) {
  const tz = cfg.timezone || DEFAULT_TZ; const out = [];
  for (let i = 0; i <= cfg.maxDaysAhead; i++) out.push(localDay(addLocalDays(now, i, tz), tz).ymd);
  return out;
}

/** Is `startISO` exactly one of today's offered, available slots? (Server-side check at checkout.) */
export function isValidSlot({ startISO, hours, cfg, now = new Date(), booked = {}, acceptingOrders = true }) {
  const t = new Date(startISO);
  if (Number.isNaN(+t)) return false;
  const tz = cfg.timezone || DEFAULT_TZ;
  const slots = generateSlots({ dateStr: localDay(t, tz).ymd, hours, cfg, now, booked, acceptingOrders });
  return slots.some((s) => s.start === t.toISOString() && s.available);
}
