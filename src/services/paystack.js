// Thin Paystack client. Uses the PLATFORM secret key. Docs: https://paystack.com/docs/api/
// Food-order payments use `subaccount` + `bearer: 'subaccount'` (see orderPayments.js).
// Subscription payments never pass a subaccount, so they settle to the platform owner only.

export class PaystackError extends Error {
  constructor(msg, status) { super(msg); this.status = status || 502; }
}

export const paystackConfigured = () => !!process.env.PAYSTACK_SECRET_KEY;

export async function ps(path, { method = 'GET', body } = {}) {
  if (!paystackConfigured()) throw new PaystackError('Paystack is not configured on this server (PAYSTACK_SECRET_KEY missing).', 503);
  const res = await fetch('https://api.paystack.co' + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) throw new PaystackError(data.message || `Paystack error (${res.status})`, res.status >= 500 ? 502 : 400);
  return data;
}

let bankCache = { at: 0, list: [] };
export async function listNigerianBanks() {
  if (Date.now() - bankCache.at < 6 * 3600000 && bankCache.list.length) return bankCache.list;
  const { data } = await ps('/bank?country=nigeria&perPage=100');
  bankCache = { at: Date.now(), list: data.map((b) => ({ name: b.name, code: b.code })).sort((a, b) => a.name.localeCompare(b.name)) };
  return bankCache.list;
}

export const resolveAccount = (accountNumber, bankCode) =>
  ps(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`).then((r) => r.data);
