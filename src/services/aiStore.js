// MongoDB side of the AI client: circuit-breaker state, usage counters and the admin-editable limits. Shared by every server instance.
import mongoose from 'mongoose';
import { AiProviderState, AiUsageEvent, AiUsageDaily, PlatformSetting } from '../models/index.js';

const KEY = 'groq';
export const AI_CONFIG_KEY = 'ai';
export const AI_DEFAULTS = Object.freeze({
  disabled: false,                       // emergency switch: turns AI off for everyone (the deterministic reader and WhatsApp keep working)
  globalDailyRequests: 0,                // 0 = no Ordarly-side cap (Groq's own limits still apply and are handled)
  perRestaurantDailyRequests: 200, perRestaurantMonthlyRequests: 3000,
  confidenceThreshold: 0.75,             // reader confidence below this may be sent to AI
  costPer1kInputUsd: 0, costPer1kOutputUsd: 0, // optional, for the estimated-cost figure only
});
const day = (d = new Date()) => d.toISOString().slice(0, 10);

let limCache = null, limAt = 0;
export async function getAiLimits() {
  if (limCache && Date.now() - limAt < 10000) return limCache;
  const row = await PlatformSetting.findOne({ key: AI_CONFIG_KEY }).lean();
  limCache = { ...AI_DEFAULTS, ...(row?.value || {}) }; limAt = Date.now(); return limCache;
}
export async function setAiLimits(patch) {
  const cur = await getAiLimits();
  await PlatformSetting.findOneAndUpdate({ key: AI_CONFIG_KEY }, { value: { ...cur, ...patch } }, { upsert: true });
  limCache = null; return getAiLimits();
}

export const aiStore = {
  async getState() { return (await AiProviderState.findOne({ key: KEY }).lean()) || { state: 'closed' }; },
  /** Only one caller wins the right to send the first request after a cool-down. */
  async claimProbe(until) {
    const r = await AiProviderState.findOneAndUpdate({ key: KEY, state: 'open', openUntil: { $lte: new Date() } }, { $set: { openUntil: until } }); return !!r;
  },
  async trip({ kind, openMs, permanent, message }) {
    const cur = await AiProviderState.findOne({ key: KEY }).lean();
    const n = (cur?.consecutiveFailures || 0) + 1;
    const ms = permanent ? openMs : Math.min(openMs * Math.min(2 ** Math.max(0, n - 1), 8), 6 * 3600000); // repeated failures wait longer
    await AiProviderState.findOneAndUpdate({ key: KEY }, { $set: { state: 'open', openUntil: new Date(Date.now() + ms), permanent: !!permanent, reason: kind, consecutiveFailures: n, lastError: { at: new Date(), kind, message: String(message).slice(0, 200) } } }, { upsert: true });
  },
  async markSuccess() { await AiProviderState.findOneAndUpdate({ key: KEY }, { $set: { state: 'closed', consecutiveFailures: 0, permanent: false, lastSuccessAt: new Date() }, $unset: { openUntil: 1, reason: 1 } }, { upsert: true }); },
  async reset() { await AiProviderState.findOneAndUpdate({ key: KEY }, { $set: { state: 'closed', consecutiveFailures: 0, permanent: false }, $unset: { openUntil: 1, reason: 1 } }, { upsert: true }); },
  async recordUsage(e) {
    if (e.skipped) { // never reached the provider: counts as a fallback, not as a request
      const d = day(); const inc = { fallbacks: 1 };
      await AiUsageDaily.updateOne({ day: d, restaurant: null }, { $inc: inc }, { upsert: true });
      if (e.restaurantId) await AiUsageDaily.updateOne({ day: d, restaurant: e.restaurantId }, { $inc: inc }, { upsert: true });
      return;
    }
    const ok = e.status === 'ok'; const rl = ['rate_limited', 'quota'].includes(e.status);
    await AiUsageEvent.create({ restaurant: e.restaurantId, conversation: e.conversationId, provider: 'groq', model: e.model, status: e.status, inputTokens: e.inputTokens || 0, outputTokens: e.outputTokens || 0, latencyMs: e.latencyMs, intent: e.intentHint, fallback: !!e.fallback });
    const inc = { requests: 1, ok: ok ? 1 : 0, failed: ok ? 0 : 1, rateLimited: rl ? 1 : 0, fallbacks: e.fallback ? 1 : 0, inputTokens: e.inputTokens || 0, outputTokens: e.outputTokens || 0, latencyMs: e.latencyMs || 0 };
    const d = day();
    await AiUsageDaily.updateOne({ day: d, restaurant: null }, { $inc: inc }, { upsert: true });
    if (e.restaurantId) await AiUsageDaily.updateOne({ day: d, restaurant: e.restaurantId }, { $inc: inc }, { upsert: true });
  },
  async usage(restaurantId) {
    const d = day(), m = d.slice(0, 7);
    const [g, r, rm] = await Promise.all([
      AiUsageDaily.findOne({ day: d, restaurant: null }).select('requests').lean(),
      restaurantId ? AiUsageDaily.findOne({ day: d, restaurant: restaurantId }).select('requests').lean() : null,
      restaurantId ? AiUsageDaily.aggregate([{ $match: { restaurant: new mongoose.Types.ObjectId(String(restaurantId)), day: { $regex: `^${m}` } } }, { $group: { _id: null, n: { $sum: '$requests' } } }]) : [],
    ]);
    return { globalDay: g?.requests || 0, restaurantDay: r?.requests || 0, restaurantMonth: rm[0]?.n || 0 };
  },
};
