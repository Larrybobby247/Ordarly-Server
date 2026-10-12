import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { PaymentConfig, User } from '../models/index.js';
import { z, validate, wrap } from '../utils/helpers.js';
import { requireAuth, loadRestaurant, requirePro } from '../middleware/auth.js';
import { ps, listNigerianBanks, resolveAccount, PaystackError } from '../services/paystack.js';

const r = Router();
r.use(requireAuth, loadRestaurant, requirePro('Online payments'));

/**
 * Subaccount status mapping. Paystack's docs show `active` and `is_verified` on a subaccount but do not
 * explain verification, so we only report "active" when BOTH are true. Set
 * PAYSTACK_ACCEPT_UNVERIFIED_SUBACCOUNTS=true if your Paystack account confirms unverified API-created
 * subaccounts can take payments.
 */
function statusFrom(sub) {
  if (sub.active === false) return 'attention';
  if (sub.is_verified || process.env.PAYSTACK_ACCEPT_UNVERIFIED_SUBACCOUNTS === 'true') return 'active';
  return 'pending';
}

r.get('/banks', wrap(async (req, res) => {
  try { res.json(await listNigerianBanks()); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
}));

// Connect: resolve the account name first so the owner can see who will be paid.
r.post('/resolve', validate(z.object({ bankCode: z.string().min(2).max(10), accountNumber: z.string().regex(/^\d{10}$/) })), wrap(async (req, res) => {
  try { const a = await resolveAccount(req.body.accountNumber, req.body.bankCode); res.json({ accountName: a.account_name }); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
}));

r.post('/connect', validate(z.object({
  bankCode: z.string().min(2).max(10), bankName: z.string().min(2).max(80),
  accountNumber: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
  password: z.string().min(1), // re-authentication for a sensitive change
})), wrap(async (req, res) => {
  const user = await User.findById(req.user._id).select('+passwordHash');
  if (!(await bcrypt.compare(req.body.password, user.passwordHash))) return res.status(403).json({ error: 'Incorrect password' });

  try {
    const acct = await resolveAccount(req.body.accountNumber, req.body.bankCode);
    const body = {
      business_name: req.restaurant.name,
      settlement_bank: req.body.bankCode, bank_code: req.body.bankCode, // Paystack docs use both names in different places
      account_number: req.body.accountNumber,
      percentage_charge: 0, // platform's share of each food payment: 0, so no commission
      primary_contact_email: req.restaurant.email,
      metadata: JSON.stringify({ restaurantId: String(req.restaurant._id) }),
    };
    const existing = await PaymentConfig.findOne({ restaurant: req.restaurant._id });
    const { data } = existing?.subaccountCode
      ? await ps(`/subaccount/${existing.subaccountCode}`, { method: 'PUT', body })
      : await ps('/subaccount', { method: 'POST', body });

    const cfg = await PaymentConfig.findOneAndUpdate({ restaurant: req.restaurant._id }, {
      provider: 'paystack', subaccountCode: data.subaccount_code || existing?.subaccountCode,
      onboardingStatus: statusFrom(data), settlementBankName: req.body.bankName,
      settlementAccountMasked: '••••••' + req.body.accountNumber.slice(-4), // full number never stored for Paystack
    }, { upsert: true, new: true });
    if (cfg.onboardingStatus !== 'active') { req.restaurant.payments.paystackEnabled = false; await req.restaurant.save(); }
    res.json({ status: cfg.onboardingStatus, accountName: acct.account_name });
  } catch (e) {
    if (e instanceof PaystackError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));

// Re-check the subaccount with Paystack (used after Paystack finishes any review).
r.post('/refresh', wrap(async (req, res) => {
  const cfg = await PaymentConfig.findOne({ restaurant: req.restaurant._id });
  if (!cfg?.subaccountCode) return res.status(400).json({ error: 'Nothing to refresh. Connect a settlement account first.' });
  try {
    const { data } = await ps(`/subaccount/${cfg.subaccountCode}`);
    cfg.onboardingStatus = statusFrom(data); await cfg.save();
    if (cfg.onboardingStatus !== 'active') { req.restaurant.payments.paystackEnabled = false; await req.restaurant.save(); }
    res.json({ status: cfg.onboardingStatus });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
}));

export default r;
