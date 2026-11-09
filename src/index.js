import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import cron from 'node-cron';

import authRoutes from './routes/auth.js';
import restaurantRoutes from './routes/restaurant.js';
import menuRoutes from './routes/menu.js';
import orderRoutes from './routes/orders.js';
import publicRoutes from './routes/public.js';
import adminRoutes from './routes/admin.js';
import { subscriptionRouter, webhookRouter } from './routes/subscription.js';
import publicPayRoutes from './routes/publicPay.js';
import paystackConnect from './routes/paystackConnect.js';
import uploadRoutes from './routes/uploads.js';
import earningsRoutes from './routes/earnings.js';
import branchRoutes from './routes/branches.js';
import staffRoutes from './routes/staff.js';
import platformRoutes from './routes/platformPublic.js';
import pushRoutes from './routes/push.js';
import inboxRoutes, { publicContact } from './routes/inbox.js';
import { reconcilePayments } from './services/reconcile.js';
import { ErrorLog } from './models/index.js';
import { sendEmail } from './services/email.js';
import { runSubscriptionSweep } from './services/subscription.js';
import { retryFailedEmails } from './services/email.js';
import { getPlanConfig } from './services/settings.js';
import { isAllowedCustomOrigin, runDomainWorker, migrateLegacyDomains } from './services/customDomain.js';
import { platformHosts } from './services/domainUtils.js';
import { runSchedulingJobs } from './services/scheduling.js';
import { backfillLedger } from './services/ledger.js';

for (const k of ['MONGODB_URI', 'JWT_SECRET', 'CLIENT_URL']) if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); }

const app = express();
app.set('trust proxy', 1); // Render puts exactly one proxy in front of the app; this makes req.ip (rate limits) the real client IP and not a spoofable header
app.use(helmet());

// PERF (new): gzip/brotli-style compression for JSON responses (menus, order lists, admin tables), typically 70-90% smaller on the wire.
// Loaded defensively: if the package is not installed yet the server still starts, just without compression.
try { const { default: compression } = await import('compression'); app.use(compression()); }
catch { console.warn('[perf] compression not installed (run npm install in server/)'); }

// Webhooks need the raw body, so mount before express.json
app.use('/api/webhooks', webhookRouter);

// CORS. Custom domains are served by the same frontend, so the browser calls this API from the restaurant's own domain.
//  - Ordarly's own frontend origins: allowed for every route (cookies/auth unchanged).
//  - A restaurant's custom domain: allowed ONLY if it is https, exactly matches an ACTIVE domain of a Pro, non-suspended restaurant,
//    and ONLY for the public ordering API (/api/public/*). Owner and admin routes are never reachable from a customer domain.
//  - Anything else gets no CORS headers (the browser blocks it). No wildcard, no thrown error, so rejected origins don't pollute the error log.
const officialOrigins = new Set([
  'https://ordarly.com.ng',
  'https://www.ordarly.com.ng',
  ...[...platformHosts()].map((h) => `https://${h}`),
  ...(process.env.CLIENT_URL ? [process.env.CLIENT_URL.replace(/\/$/, '')] : []),
]);

app.use(cors((req, callback) => {
  const origin = req.get('origin');
  const base = { credentials: true, maxAge: 600 };
  if (!origin || officialOrigins.has(origin)) return callback(null, { ...base, origin: true });
  if (!req.path.startsWith('/api/public/')) return callback(null, { ...base, origin: false });
  isAllowedCustomOrigin(origin).then((ok) => callback(null, { ...base, origin: ok })).catch(() => callback(null, { ...base, origin: false }));
}));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

const limiter = (max, windowMs = 15 * 60 * 1000) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth/login', limiter(20));
app.use('/api/auth/register', limiter(10));
app.use('/api/auth/forgot-password', limiter(5));
app.use('/api/auth/accept-invite', limiter(20));
app.use('/api/auth/invite', limiter(60));
app.use('/api/staff/invite', limiter(30, 60 * 60 * 1000));
app.use('/api/public', limiter(300));
app.use('/api/public/r/:slug/checkout', limiter(30));
app.use('/api/public/r/:slug/places', limiter(120));
app.use('/api/public/r/:slug/delivery-quote', limiter(60));
app.use('/api/restaurant/places', limiter(60));
app.use('/api/public/places', limiter(40));
app.use('/api/public/track/:token/proof', limiter(10));
app.use('/api/public/track/:token/pay', limiter(20));
app.use('/api/uploads', limiter(60));
// Custom domains: registering touches the Vercel API and DNS checks hit resolvers, so both are tightly limited per IP.
app.use('/api/restaurant/custom-domain/verify', limiter(30, 10 * 60 * 1000));
const domainWrites = limiter(12, 60 * 60 * 1000); // created ONCE so its counters persist between requests
app.use('/api/restaurant/custom-domain', (req, res, next) => (['PUT', 'DELETE'].includes(req.method) ? domainWrites(req, res, next) : next()));
app.use('/api/public/complaints', limiter(8, 60 * 60 * 1000));
app.use('/api/public/contact', limiter(10, 60 * 60 * 1000));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/restaurant/payments/paystack', paystackConnect);
app.use('/api/restaurant', restaurantRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/earnings', earningsRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/subscription', subscriptionRouter);
app.use('/api/public', platformRoutes);
app.use('/api/public', publicContact);
app.use('/api/inbox', inboxRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/public', publicPayRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/admin', adminRoutes);

let lastAlert = 0;
app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) {
    console.error('[error]', err);
    ErrorLog.create({ route: req.originalUrl.split('?')[0], method: req.method, message: err.message, stack: String(err.stack || '').slice(0, 2000), status }).catch(() => {});
    if (process.env.ADMIN_ALERT_EMAIL && Date.now() - lastAlert > 10 * 60000) { // throttled: max one alert per 10 min
      lastAlert = Date.now();
      sendEmail({ to: process.env.ADMIN_ALERT_EMAIL, type: 'admin_alert', subject: 'Ordarly server error', body: `<p>${req.method} ${req.originalUrl.split('?')[0]}: ${String(err.message).replace(/[<>]/g, '')}</p>` });
    }
  }
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 5 MB).' : status >= 500 ? 'Something went wrong' : err.message;
  res.status(status).json({ error: msg });
});

// PERF (changed): one shared connection pool for the whole process (never connect per request). A small warm minimum avoids a
// slow first query after quiet periods; the max keeps us well inside typical Atlas connection limits. Failing fast beats hanging.
await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 20, minPoolSize: 2, serverSelectionTimeoutMS: 10000 });
await getPlanConfig();

// Subscription sweep every 10 min, email retries every 5 min (server-side timestamps, UTC)
cron.schedule('*/10 * * * *', () => runSubscriptionSweep().catch((e) => console.error('[sweep]', e)));
cron.schedule('*/5 * * * *', () => retryFailedEmails().catch((e) => console.error('[email retry]', e)));

// Custom-domain verification: every minute, but each domain is only touched when ITS next check is due (30s -> 2h back-off), in small batches.
cron.schedule('* * * * *', () => runDomainWorker().catch((e) => console.error('[domains]', e)));
migrateLegacyDomains().catch((e) => console.error('[domains] legacy migration', e));
// Scheduled orders: give back slots of unpaid online orders and remind restaurants shortly before each scheduled order is due.
cron.schedule('* * * * *', () => runSchedulingJobs().catch((e) => console.error('[scheduling]', e)));
// One-time: put already-completed orders into the new earnings ledger at 0% commission (idempotent).
backfillLedger().catch((e) => console.error('[ledger] backfill', e));

cron.schedule('*/5 * * * *', () => reconcilePayments().catch((e) => console.error('[reconcile]', e)));

const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`API listening on :${port}`));
