import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

/** Detect real image type from magic bytes (never trust the client's mimetype/filename). */
export function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null; // SVG, GIF, PDF, etc. rejected for v1
}

/** PUBLIC images (logo, cover, meals) -> Cloudinary via signed REST upload (no SDK needed). */
export async function uploadPublicImage(buf, mime, folder = 'orderly') {
  const { CLOUDINARY_CLOUD_NAME: cloud, CLOUDINARY_API_KEY: key, CLOUDINARY_API_SECRET: secret } = process.env;
  if (!cloud || !key || !secret) throw Object.assign(new Error('Image uploads are not configured (Cloudinary env vars missing). Paste an image URL instead.'), { status: 503 });
  const timestamp = Math.floor(Date.now() / 1000);
  const toSign = `folder=${folder}&timestamp=${timestamp}${secret}`;
  const signature = crypto.createHash('sha1').update(toSign).digest('hex');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), 'upload');
  form.append('api_key', key); form.append('timestamp', String(timestamp)); form.append('folder', folder); form.append('signature', signature);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message || 'Image upload failed'), { status: 502 });
  return data.secure_url;
}

/**
 * PRIVATE payment proofs: stored on local disk under PROOF_DIR, never served statically.
 * They are only readable through an authenticated route that checks restaurant ownership.
 * NOTE: hosts with ephemeral disks (e.g. Render free) need a persistent disk mounted at PROOF_DIR,
 * or swap this module for a private S3/R2 bucket with signed URLs.
 */
const dir = () => process.env.PROOF_DIR || path.resolve(process.cwd(), 'private-proofs');

export async function saveProof(buf, ext) {
  const key = `${crypto.randomBytes(24).toString('hex')}.${ext}`; // unguessable, not derived from order id
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(path.join(dir(), key), buf, { mode: 0o600 });
  return key;
}

export async function readProof(key) {
  if (!/^[a-f0-9]{48}\.(jpg|png|webp)$/.test(key)) throw new Error('bad key'); // blocks path traversal
  return fs.readFile(path.join(dir(), key));
}
