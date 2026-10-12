import { PlatformSetting } from '../models/index.js';
import { DEFAULT_PLAN_CONFIG } from '../config/plans.js';

export async function getPlanConfig() {
  const doc = await PlatformSetting.findOne({ key: 'plans' }).lean();
  if (doc) {
    // One-off: the old default price (5,000) becomes the new default (7,500). Prices an admin set to anything else are kept.
    if (doc.value?.pro?.priceNgn === 5000) { doc.value.pro.priceNgn = 7500; await PlatformSetting.updateOne({ key: 'plans' }, { value: doc.value }); }
    return doc.value;
  }
  await PlatformSetting.create({ key: 'plans', value: DEFAULT_PLAN_CONFIG });
  return DEFAULT_PLAN_CONFIG;
}

export async function setPlanConfig(patch) {
  const cur = await getPlanConfig();
  const next = {
    free: { ...cur.free, ...(patch.free || {}) },
    pro: { ...cur.pro, ...(patch.pro || {}) },
  };
  await PlatformSetting.updateOne({ key: 'plans' }, { value: next }, { upsert: true });
  return next;
}

const platformDefaults = () => ({
  supportEmail: process.env.SUPPORT_EMAIL || '',
  registrationOpen: true,
  announcement: { enabled: false, text: '', tone: 'info' },
});

export async function getPlatformSettings() {
  const doc = await PlatformSetting.findOne({ key: 'platform' }).lean();
  const d = platformDefaults();
  return { ...d, ...(doc?.value || {}), announcement: { ...d.announcement, ...(doc?.value?.announcement || {}) } };
}

export async function setPlatformSettings(patch) {
  const cur = await getPlatformSettings();
  const next = { ...cur, ...patch, announcement: { ...cur.announcement, ...(patch.announcement || {}) } };
  await PlatformSetting.updateOne({ key: 'platform' }, { value: next }, { upsert: true });
  return next;
}
