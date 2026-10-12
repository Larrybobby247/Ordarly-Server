import { Router } from 'express';
import multer from 'multer';
import { wrap } from '../utils/helpers.js';
import { requireAuth, loadRestaurant } from '../middleware/auth.js';
import { sniffImage, uploadPublicImage } from '../services/storage.js';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

// Public-facing images only (logo, cover, meal photos). Payment proofs use a separate private path.
r.post('/image', requireAuth, loadRestaurant, upload.single('image'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image (JPG, PNG or WebP, max 5 MB).' });
  const kind = sniffImage(req.file.buffer);
  if (!kind) return res.status(400).json({ error: 'Only JPG, PNG or WebP images are accepted.' });
  const url = await uploadPublicImage(req.file.buffer, kind.mime, `orderly/${req.restaurant._id}`);
  res.json({ url });
}));

export default r;
