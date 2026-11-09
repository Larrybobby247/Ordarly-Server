// Time-zone helpers built on Intl (no dependency). Everything restaurant-facing uses the RESTAURANT's zone, never the server's.
export const DEFAULT_TZ = 'Africa/Lagos';

export function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }
export const tzOf = (rest) => (rest?.scheduling?.timezone && validTz(rest.scheduling.timezone) ? rest.scheduling.timezone : DEFAULT_TZ);

/** Offset (ms) of `tz` from UTC at the instant `date`. */
export function tzOffsetMs(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Wall-clock time in `tz` -> the real UTC instant. */
export function zonedToUtc(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = tzOffsetMs(new Date(guess), tz);
  let utc = guess - off1;
  const off2 = tzOffsetMs(new Date(utc), tz);
  if (off2 !== off1) utc = guess - off2; // crossed a DST change
  return new Date(utc);
}

/** {y,m,d,dow,ymd} of the local calendar day containing `date` in `tz`. */
export function localDay(date, tz) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const [y, m, d] = ymd.split('-').map(Number);
  return { y, m, d, ymd, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

export const startOfLocalDay = (date, tz) => { const l = localDay(date, tz); return zonedToUtc(l.y, l.m, l.d, 0, 0, tz); };
export const addLocalDays = (date, n, tz) => { const l = localDay(date, tz); return zonedToUtc(l.y, l.m, l.d + n, 0, 0, tz); };

/** Date range used by the earnings filters. Returns { from, to } (to exclusive) as UTC Dates. */
export function rangeBounds(range, { now = new Date(), tz = DEFAULT_TZ, from, to } = {}) {
  const today = startOfLocalDay(now, tz);
  const tomorrow = addLocalDays(now, 1, tz);
  const l = localDay(now, tz);
  switch (range) {
    case 'today': return { from: today, to: tomorrow };
    case 'yesterday': return { from: addLocalDays(now, -1, tz), to: today };
    case '7d': return { from: addLocalDays(now, -6, tz), to: tomorrow };
    case '30d': return { from: addLocalDays(now, -29, tz), to: tomorrow };
    case 'month': return { from: zonedToUtc(l.y, l.m, 1, 0, 0, tz), to: tomorrow };
    case 'lastmonth': return { from: zonedToUtc(l.y, l.m - 1, 1, 0, 0, tz), to: zonedToUtc(l.y, l.m, 1, 0, 0, tz) };
    case 'custom': {
      const f = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from.split('-').map(Number) : null;
      const t = /^\d{4}-\d{2}-\d{2}$/.test(to || '') ? to.split('-').map(Number) : null;
      if (!f || !t) return null;
      const a = zonedToUtc(f[0], f[1], f[2], 0, 0, tz), b = zonedToUtc(t[0], t[1], t[2] + 1, 0, 0, tz); // "to" day is included
      return a < b ? { from: a, to: b } : null;
    }
    default: return null; // 'all'
  }
}

/** "Fri 7 Nov, 3:30 PM" in the restaurant's zone. */
export const formatLocal = (date, tz = DEFAULT_TZ) => new Intl.DateTimeFormat('en-NG', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(date));
