// Default wiring for AI interpretation (real fetch + MongoDB). The prompt and validation rules live in whatsappAiCore.js (pure, unit-tested).
import { createAiClient } from './aiClient.js';
import { aiStore, getAiLimits } from './aiStore.js';
import { SYSTEM_PROMPT, buildUserPrompt, validateInterpretation, AI_MIN_CONFIDENCE } from './whatsappAiCore.js';
export { AI_INTENTS, AI_MIN_CONFIDENCE, validateInterpretation, buildUserPrompt } from './whatsappAiCore.js';

export const aiClient = createAiClient({ store: aiStore, getLimits: getAiLimits });

/** Asks the AI to interpret a message. Resolves { ok:true, interpretation } or { ok:false, kind }. Never throws. */
export async function interpretWithAi({ client = aiClient, restaurantId, conversationId, text, state, menu }) {
  try {
    const r = await client.chatJson({ system: SYSTEM_PROMPT, user: buildUserPrompt({ text, state, menu }), meta: { restaurantId, conversationId } });
    if (!r.ok) return { ok: false, kind: r.kind };
    const v = validateInterpretation(r.json, menu);
    if (!v || v.confidence < AI_MIN_CONFIDENCE) return { ok: false, kind: v ? 'low_confidence' : 'malformed' };
    return { ok: true, interpretation: v };
  } catch { return { ok: false, kind: 'error' }; }
}
