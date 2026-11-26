// Read-only AI status for dashboards (never consumes the circuit-breaker probe and never calls the provider).
// "Basic mode" = the deterministic WhatsApp assistant working alone. WhatsApp automation itself is never affected by AI problems.
import { aiClient } from './whatsappAi.js';
import { aiStore, getAiLimits } from './aiStore.js';
import { AiUsageDaily, AiUsageEvent, AiProviderState, WhatsAppIntegration } from '../models/index.js';

const day = (d = new Date()) => d.toISOString().slice(0, 10);

export async function aiStatusFor(restaurantId, integ) {
  const lim = await getAiLimits();
  const st = await aiStore.getState();
  const u = await aiStore.usage(restaurantId);
  let state = 'available', why = null;
  if (lim.disabled) { state = 'disabled_by_admin'; why = 'AI help is switched off by Ordarly.'; }
  else if (!aiClient.configured()) { state = 'not_configured'; why = 'AI help is not set up on the platform yet.'; }
  else if (st.state === 'open' && st.openUntil && new Date(st.openUntil) > new Date()) { state = 'temporarily_unavailable'; why = 'AI help is temporarily unavailable. Your assistant keeps working in basic mode.'; }
  else if (lim.perRestaurantDailyRequests > 0 && u.restaurantDay >= lim.perRestaurantDailyRequests) { state = 'limit_reached'; why = "Today's AI help limit for your restaurant is reached. Your assistant keeps working in basic mode."; }
  else if (lim.perRestaurantMonthlyRequests > 0 && u.restaurantMonth >= lim.perRestaurantMonthlyRequests) { state = 'limit_reached'; why = "This month's AI help limit for your restaurant is reached. Your assistant keeps working in basic mode."; }
  const enabled = !!integ?.settings?.aiEnabled;
  return {
    enabled, state, why, basicMode: !enabled || state !== 'available',
    usage: { today: u.restaurantDay, month: u.restaurantMonth, dailyLimit: lim.perRestaurantDailyRequests || null, monthlyLimit: lim.perRestaurantMonthlyRequests || null },
  };
}

/** Admin monitoring snapshot. Counts only; no customer text is stored or shown. */
export async function aiAdminSnapshot() {
  const lim = await getAiLimits();
  const st = await AiProviderState.findOne({ key: 'groq' }).lean();
  const today = day(), from = day(new Date(Date.now() - 29 * 86400000));
  const [days, byRest, recentFail, enabledIds] = await Promise.all([
    AiUsageDaily.find({ restaurant: null, day: { $gte: from } }).sort('day').lean(),
    AiUsageDaily.aggregate([{ $match: { restaurant: { $ne: null }, day: { $gte: from } } }, { $group: { _id: '$restaurant', requests: { $sum: '$requests' }, failed: { $sum: '$failed' }, fallbacks: { $sum: '$fallbacks' }, rateLimited: { $sum: '$rateLimited' }, inputTokens: { $sum: '$inputTokens' }, outputTokens: { $sum: '$outputTokens' } } }, { $sort: { requests: -1 } }, { $limit: 50 }, { $lookup: { from: 'restaurants', localField: '_id', foreignField: '_id', as: 'r' } }, { $project: { name: { $arrayElemAt: ['$r.name', 0] }, requests: 1, failed: 1, fallbacks: 1, rateLimited: 1, inputTokens: 1, outputTokens: 1 } }]),
    AiUsageEvent.find({ status: { $ne: 'ok' } }).sort('-createdAt').limit(30).select('restaurant status model createdAt latencyMs').lean(),
    WhatsAppIntegration.countDocuments({ 'settings.aiEnabled': true }),
  ]);
  const t = days.find((d) => d.day === today) || {};
  const sum = (k) => days.reduce((a, d) => a + (d[k] || 0), 0);
  const withoutAi = await WhatsAppIntegration.countDocuments({ connectionStatus: { $ne: 'not_connected' }, 'settings.aiEnabled': { $ne: true } });
  return {
    provider: 'groq', model: aiClient.model(), configured: aiClient.configured(), limits: lim,
    breaker: { state: st?.state || 'closed', reason: st?.reason || null, openUntil: st?.openUntil || null, permanent: !!st?.permanent, consecutiveFailures: st?.consecutiveFailures || 0, lastSuccessAt: st?.lastSuccessAt || null, lastError: st?.lastError || null },
    today: { requests: t.requests || 0, ok: t.ok || 0, failed: t.failed || 0, rateLimited: t.rateLimited || 0, fallbacks: t.fallbacks || 0, inputTokens: t.inputTokens || 0, outputTokens: t.outputTokens || 0, avgLatencyMs: t.ok ? Math.round((t.latencyMs || 0) / t.ok) : null },
    last30: { requests: sum('requests'), failed: sum('failed'), rateLimited: sum('rateLimited'), fallbacks: sum('fallbacks'), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), fallbackRate: sum('requests') ? sum('fallbacks') / sum('requests') : 0 },
    series: days.map((d) => ({ day: d.day, requests: d.requests, failed: d.failed, rateLimited: d.rateLimited })),
    restaurants: byRest, restaurantsWithAi: enabledIds, restaurantsWithoutAi: withoutAi, recentFailures: recentFail,
  };
}
