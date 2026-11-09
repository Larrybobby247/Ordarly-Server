import { Router } from 'express';
import mongoose from 'mongoose';
import { StaffMember, Branch } from '../models/index.js';
import { z, validate, wrap, sha256, randomToken } from '../utils/helpers.js';
import { requireAuth, loadRestaurant, requirePerm, requireBusiness } from '../middleware/auth.js';
import { PERMS, ROLES, canGrant } from '../services/access.js';
import { sendEmail, btn } from '../services/email.js';

const r = Router();
r.use(requireAuth, loadRestaurant, requireBusiness('Staff management'), requirePerm('staff'));

const grantSchema = z.object({
  role: z.enum(ROLES),
  branchIds: z.array(z.string()).max(100).default([]),
  allBranches: z.boolean().optional(),            // custom role only
  perms: z.array(z.enum(PERMS)).max(PERMS.length).default([]), // custom role only
});
const inviteSchema = grantSchema.extend({ email: z.string().email().max(200), name: z.string().max(80).optional() });

/** Checks the requested access makes sense, belongs to THIS restaurant, and is not more than the inviter holds. Returns { error } or { grant }. */
async function checkGrant(req, b) {
  const ids = [...new Set(b.branchIds)];
  if (ids.some((id) => !mongoose.isValidObjectId(id))) return { error: 'Unknown branch.' };
  if (ids.length) { const n = await Branch.countDocuments({ restaurant: req.restaurant._id, _id: { $in: ids } }); if (n !== ids.length) return { error: 'One of the branches does not belong to this restaurant.' }; }
  const grant = { role: b.role, branchIds: ids, allBranches: b.role === 'custom' ? !!b.allBranches : b.role === 'all_branches_manager', perms: b.role === 'custom' ? b.perms : [] };
  if (b.role === 'branch_manager' && !ids.length) return { error: 'Choose the branch this manager looks after.' };
  if (b.role === 'custom' && !grant.perms.length) return { error: 'Tick at least one permission.' };
  if (b.role === 'custom' && !grant.allBranches && !ids.length) return { error: 'Choose at least one branch, or give access to all branches.' };
  if (!canGrant(req.access, grant)) return { error: 'You can only give access that you have yourself.' };
  return { grant };
}

const view = (m) => ({ _id: m._id, email: m.email, name: m.name, role: m.role, branches: m.branches, allBranches: m.allBranches, perms: m.perms, status: m.status, expiresAt: m.expiresAt, acceptedAt: m.acceptedAt, createdAt: m.createdAt });
const inviteUrl = (token) => `${(process.env.CLIENT_URL || '').replace(/\/+$/, '')}/accept-invite?token=${token}`;

async function sendInvite(req, member, token) {
  await sendEmail({
    to: member.email, type: 'staff_invite', restaurant: req.restaurant._id, dedupeKey: `invite:${member._id}:${+member.expiresAt}`,
    subject: `${req.user.name} invited you to help run ${req.restaurant.name} on Ordarly`,
    body: `<p>${req.user.name} invited you to manage <b>${req.restaurant.name}</b> on Ordarly. This link works for 7 days.</p>${btn(inviteUrl(token), 'Accept invitation')}`,
  });
}

r.get('/', wrap(async (req, res) => {
  const all = await StaffMember.find({ restaurant: req.restaurant._id }).sort('-createdAt').lean();
  // Non-owners only see people whose access fits inside their own (so they cannot see or edit someone more powerful).
  const visible = all.filter((m) => req.access.isOwner || canGrant(req.access, { role: m.role, branchIds: (m.branches || []).map(String), allBranches: m.allBranches, perms: m.perms }));
  res.json({ staff: visible.map(view) });
}));

r.post('/invite', validate(inviteSchema), wrap(async (req, res) => {
  const email = req.body.email.toLowerCase();
  if (email === req.user.email) return res.status(400).json({ error: 'You cannot invite yourself.' });
  const chk = await checkGrant(req, req.body); if (chk.error) return res.status(400).json({ error: chk.error });
  const existing = await StaffMember.findOne({ restaurant: req.restaurant._id, email });
  if (existing?.status === 'active') return res.status(409).json({ error: 'That person already has access. Edit their access instead.' });
  const token = randomToken(24);
  const fields = { role: chk.grant.role, branches: chk.grant.branchIds, allBranches: chk.grant.allBranches, perms: chk.grant.perms, name: req.body.name, status: 'invited', tokenHash: sha256(token), expiresAt: new Date(Date.now() + 7 * 86400000), invitedBy: req.user._id };
  const member = existing ? Object.assign(existing, fields) : new StaffMember({ restaurant: req.restaurant._id, email, ...fields });
  await member.save();
  await sendInvite(req, member, token);
  res.status(201).json({ member: view(member) });
}));

r.patch('/:id', validate(grantSchema), wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const m = await StaffMember.findOne({ _id: req.params.id, restaurant: req.restaurant._id });
  if (!m || m.status === 'revoked') return res.status(404).json({ error: 'Not found' });
  // You may only edit someone whose current access you could have granted, and only to something you could grant.
  if (!canGrant(req.access, { role: m.role, branchIds: (m.branches || []).map(String), allBranches: m.allBranches, perms: m.perms })) return res.status(403).json({ error: 'You cannot change this person\'s access.' });
  const chk = await checkGrant(req, req.body); if (chk.error) return res.status(400).json({ error: chk.error });
  Object.assign(m, { role: chk.grant.role, branches: chk.grant.branchIds, allBranches: chk.grant.allBranches, perms: chk.grant.perms });
  await m.save();
  res.json({ member: view(m) });
}));

r.post('/:id/resend', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const m = await StaffMember.findOne({ _id: req.params.id, restaurant: req.restaurant._id, status: 'invited' });
  if (!m) return res.status(404).json({ error: 'No pending invitation' });
  const token = randomToken(24);
  m.tokenHash = sha256(token); m.expiresAt = new Date(Date.now() + 7 * 86400000); await m.save();
  await sendInvite(req, m, token);
  res.json({ member: view(m) });
}));

// Revoke: takes effect on their very next request (access is looked up on every call, not stored in the login session).
r.delete('/:id', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const m = await StaffMember.findOne({ _id: req.params.id, restaurant: req.restaurant._id });
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (!canGrant(req.access, { role: m.role, branchIds: (m.branches || []).map(String), allBranches: m.allBranches, perms: m.perms })) return res.status(403).json({ error: 'You cannot remove this person.' });
  m.status = 'revoked'; m.tokenHash = undefined; await m.save();
  res.json({ ok: true });
}));

export default r;
