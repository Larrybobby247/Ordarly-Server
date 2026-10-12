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
import platformRoutes from './routes/platformPublic.js';
import inboxRoutes, { publicContact } from './routes/inbox.js';
import { reconcilePayments } from './services/reconcile.js';
import { ErrorLog } from './models/index.js';
import { sendEmail } from './services/email.js';
import { runSubscriptionSweep } from './services/subscription.js';
import { retryFailedEmails } from './services/email.js';
import { getPlanConfig } from './services/settings.js';

for (const k of ['MONGODB_URI', 'JWT_SECRET', 'CLIENT_URL']) if (!process.env[k]) { console.error(`Missing env ${k}`); process.exit(1); }

const app = express();
app.set('trust proxy', 1);
app.use(helmet());

// Webhooks need the raw body, so mount before express.json
app.use('/api/webhooks', webhookRouter);

// Custom domains are served by the same frontend, so allow any origin that is the main client
// or a verified custom domain (checked dynamically).
app.use(cors({ origin: (o, cb) => cb(null, !o || o === process.env.CLIENT_URL || /^https:\/\//.test(o)), credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

const limiter = (max, windowMs = 15 * 60 * 1000) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth/login', limiter(20));
app.use('/api/auth/register', limiter(10));
app.use('/api/auth/forgot-password', limiter(5));
app.use('/api/public', limiter(300));
app.use('/api/public/r/:slug/checkout', limiter(30));
app.use('/api/public/r/:slug/places', limiter(120));
app.use('/api/public/r/:slug/delivery-quote', limiter(60));
app.use('/api/restaurant/places', limiter(60));
app.use('/api/public/places', limiter(40));
app.use('/api/public/track/:token/proof', limiter(10));
app.use('/api/public/track/:token/pay', limiter(20));
app.use('/api/uploads', limiter(60));
app.use('/api/public/complaints', limiter(8, 60 * 60 * 1000));
app.use('/api/public/contact', limiter(10, 60 * 60 * 1000));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/restaurant/payments/paystack', paystackConnect);
app.use('/api/restaurant', restaurantRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/subscription', subscriptionRouter);
app.use('/api/public', platformRoutes);
app.use('/api/public', publicContact);
app.use('/api/inbox', inboxRoutes);
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

await mongoose.connect(process.env.MONGODB_URI);
await getPlanConfig();

// Subscription sweep every 10 min, email retries every 5 min (server-side timestamps, UTC)
cron.schedule('*/10 * * * *', () => runSubscriptionSweep().catch((e) => console.error('[sweep]', e)));
cron.schedule('*/5 * * * *', () => retryFailedEmails().catch((e) => console.error('[email retry]', e)));

cron.schedule('*/5 * * * *', () => reconcilePayments().catch((e) => console.error('[reconcile]', e)));

const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`API listening on :${port}`));
