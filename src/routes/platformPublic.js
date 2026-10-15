import { Router } from 'express';
import { Complaint, Restaurant } from '../models/index.js';
import { z, validate, wrap, randomToken, escapeHtml } from '../utils/helpers.js';
import { getPlatformSettings, getPlanConfig } from '../services/settings.js';
import { sendEmail } from '../services/email.js';
import { autocomplete } from '../services/places.js';

const r = Router();

// Public platform info: support email, announcement banner, whether sign-ups are open.
r.get('/platform', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300'); // PERF (new): public, rarely-changing settings
  const [s, plans] = await Promise.all([getPlatformSettings(), getPlanConfig()]);
  res.json({
    pricing: { proPriceNgn: plans.pro.priceNgn, trialDays: plans.pro.trialDays, freeMeals: plans.free.maxActiveMeals },
    supportEmail: s.supportEmail,
    registrationOpen: s.registrationOpen,
    announcement: s.announcement.enabled && s.announcement.text ? s.announcement : { enabled: false },
  });
}));

// Address suggestions for the sign-up form (no account yet). Rate-limited in index.js.
r.post('/places/autocomplete', validate(z.object({ input: z.string().min(3).max(120), sessionToken: z.string().max(64).optional() })), wrap(async (req, res) => {
  res.json({ suggestions: await autocomplete(req.body.input, { sessionToken: req.body.sessionToken }) });
}));

const complaintSchema = z.object({
  kind: z.enum(['complaint', 'question', 'feedback']).default('question'),
  source: z.enum(['contact', 'restaurant_page', 'tracking']).default('contact'),
  name: z.string().min(2).max(80),
  email: z.string().email(),
  phone: z.string().max(20).optional(),
  subject: z.string().max(120).optional(),
  message: z.string().min(10, 'Please write at least a sentence').max(2000),
  restaurantSlug: z.string().max(60).optional(),
  orderRef: z.string().max(30).optional(),
  website: z.string().optional(), // honeypot: real people never fill this in
});

r.post('/complaints', validate(complaintSchema), wrap(async (req, res) => {
  const b = req.body;
  if (b.website) return res.status(201).json({ ok: true }); // bots get a fake success and nothing is stored

  const restaurant = b.restaurantSlug
    ? await Restaurant.findOne({ slug: b.restaurantSlug.toLowerCase() }).select('_id name')
    : null;
  const c = await Complaint.create({
    reference: 'CMP-' + randomToken(3).toUpperCase(),
    kind: b.kind, source: b.source, name: b.name, email: b.email.toLowerCase(), phone: b.phone,
    subject: b.subject, message: b.message, restaurant: restaurant?._id,
    orderRef: b.orderRef ? b.orderRef.toUpperCase() : undefined,
  });

  if (process.env.ADMIN_ALERT_EMAIL) {
    sendEmail({
      to: process.env.ADMIN_ALERT_EMAIL, type: 'admin_new_complaint', dedupeKey: `cmp:${c._id}`,
      subject: `New ${c.kind} ${c.reference}`,
      body: `<p><b>${escapeHtml(c.name)}</b> (${escapeHtml(c.email)}) wrote:</p><p>${escapeHtml(c.message).slice(0, 600)}</p>`,
    });
  }
  sendEmail({
    to: c.email, type: 'complaint_received', dedupeKey: `cmp-ack:${c._id}`,
    subject: `We received your message (${c.reference})`,
    body: `<p>Hi ${escapeHtml(c.name)}, thanks for getting in touch. Your reference is <b>${c.reference}</b>. We will reply by email.</p>`,
  });
  res.status(201).json({ ok: true, reference: c.reference });
}));

export default r;
