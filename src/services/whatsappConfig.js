// WhatsApp platform settings the Ordarly administrator controls: nothing about credits or prices is hard-coded in the code that uses it.
import { PlatformSetting, WhatsAppCreditPackage } from '../models/index.js';
import { DEFAULT_CREDIT_CONFIG } from './whatsappCreditsMath.js';

const KEY = 'whatsapp';
let cache = null, at = 0;

export async function getCreditConfig() {
  if (cache && Date.now() - at < 15000) return cache;
  const row = await PlatformSetting.findOne({ key: KEY }).lean();
  const v = row?.value || {};
  cache = {
    allowances: { ...DEFAULT_CREDIT_CONFIG.allowances, ...(v.allowances || {}) },
    reservationTimeoutHours: Number(v.reservationTimeoutHours) > 0 ? Number(v.reservationTimeoutHours) : DEFAULT_CREDIT_CONFIG.reservationTimeoutHours,
    warnAtPercent: Array.isArray(v.warnAtPercent) && v.warnAtPercent.length === 2 ? v.warnAtPercent.map(Number) : [...DEFAULT_CREDIT_CONFIG.warnAtPercent],
    purchasedCreditPolicy: typeof v.purchasedCreditPolicy === 'string' ? v.purchasedCreditPolicy : '', // optional extra wording shown before a purchase
  };
  at = Date.now();
  return cache;
}

export async function setCreditConfig(patch) {
  const cur = await getCreditConfig();
  const next = { ...cur, ...patch, allowances: { ...cur.allowances, ...(patch.allowances || {}) } };
  await PlatformSetting.findOneAndUpdate({ key: KEY }, { value: next }, { upsert: true });
  cache = null;
  return getCreditConfig();
}

/** First run only: the three suggested packs, switched OFF with no price. The administrator sets prices and turns them on. */
export async function ensureDefaultPackages() {
  if (await WhatsAppCreditPackage.estimatedDocumentCount()) return;
  await WhatsAppCreditPackage.insertMany([
    { name: 'Small', credits: 500, sort: 1 }, { name: 'Medium', credits: 1500, sort: 2 }, { name: 'Large', credits: 5000, sort: 3 },
  ]);
}
