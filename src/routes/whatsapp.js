// WhatsApp Commerce: the restaurant's three on/off controls (connection, automation, accepting orders).
// Owner only (staff are default-denied for /api/whatsapp in services/access.js). Every rule is enforced here and in the guards, never just in the browser.
import { Router } from 'express';
import { z, validate, wrap } from '../utils/helpers.js';
import { requireAuth, loadRestaurant, requireOwner } from '../middleware/auth.js';
import { restaurantUrl } from '../services/customDomain.js';
import { STATUS_INFO, evaluate } from '../services/whatsappControls.js';
import { getIntegration, updateControls, disconnect, controlHistory } from '../services/whatsappControlsStore.js';

const r = Router();
r.use(requireAuth, loadRestaurant, requireOwner);

const stamp = (c) => (c?.at ? { at: c.at, byName: c.byName || null } : null);

/** What the dashboard sees. Contains no token and nothing secret. */
async function view(req, integ) {
  const e = evaluate(integ);
  const info = STATUS_INFO[e.status];
  const rest = req.restaurant;
  return {
    connection: {
      status: e.status, label: info.label, help: info.help, connected: e.connected,
      id: integ?._id ? String(integ._id) : null, displayPhoneNumber: integ?.displayPhoneNumber || null, verifiedDisplayName: integ?.verifiedDisplayName || null,
      lastChange: stamp(integ?.changes?.connection),
      canConnect: false, // switched on by the Embedded Signup phase; until then no restaurant can reach "connected"
    },
    automation: { enabled: e.automationEnabled, active: e.automationActive, lastChange: stamp(integ?.changes?.automation) },
    orders: {
      enabled: e.acceptOrdersEnabled, active: e.ordersActive, lastChange: stamp(integ?.changes?.orders),
      onlineOrderingUrl: restaurantUrl(rest, { customDomainActive: rest.customDomainStatus === 'active' && req.isPro }), // offered to customers while WhatsApp orders are off
    },
    history: (await controlHistory(rest._id)).map((h) => ({ control: h.control, from: h.from, to: h.to, byName: h.byName, note: h.note, at: h.createdAt })),
  };
}

const apply = async (req, res, patch) => {
  const out = await updateControls(req.restaurant._id, patch, req.user);
  if (out.error) return res.status(out.status || 409).json({ error: out.error, code: out.code });
  res.json({ ...(await view(req, out.integration)), changed: out.changed });
};

r.get('/controls', wrap(async (req, res) => res.json(await view(req, await getIntegration(req.restaurant._id)))));

// Either control, or both at once. Anything left out is not touched.
r.patch('/controls', validate(z.object({ automationEnabled: z.boolean().optional(), acceptOrdersEnabled: z.boolean().optional() })
  .refine((v) => v.automationEnabled !== undefined || v.acceptOrdersEnabled !== undefined, { message: 'Nothing to change.' })), wrap((req, res) => apply(req, res, req.body)));

r.post('/automation/toggle', validate(z.object({ enabled: z.boolean() })), wrap((req, res) => apply(req, res, { automationEnabled: req.body.enabled })));
r.post('/orders/toggle', validate(z.object({ enabled: z.boolean() })), wrap((req, res) => apply(req, res, { acceptOrdersEnabled: req.body.enabled })));

// Disconnect. The :id must be THIS restaurant's integration, so one restaurant can never disconnect another's.
r.delete('/integrations/:id', wrap(async (req, res) => {
  const integ = await getIntegration(req.restaurant._id);
  if (!integ || String(integ._id) !== req.params.id) return res.status(404).json({ error: 'WhatsApp connection not found.' });
  const out = await disconnect(req.restaurant._id, req.user);
  if (out.error) return res.status(out.status || 409).json({ error: out.error, code: out.code });
  res.json({ ...(await view(req, out.integration)), changed: out.changed, metaRevoked: out.metaRevoked, metaNote: out.metaNote });
}));

export default r;
