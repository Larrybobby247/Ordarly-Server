import { Router } from 'express';
import { Category, Meal } from '../models/index.js';
import { z, validate, wrap } from '../utils/helpers.js';
import { requireAuth, loadRestaurant } from '../middleware/auth.js';

const r = Router();
r.use(requireAuth, loadRestaurant);

const limitInfo = async (req) => {
  const max = req.isPro ? null : req.planConfig.free.maxActiveMeals;
  const active = await Meal.countDocuments({ restaurant: req.restaurant._id, available: true });
  return { max, active };
};

r.get('/', wrap(async (req, res) => {
  const [categories, meals, limit] = await Promise.all([
    Category.find({ restaurant: req.restaurant._id }).sort('sort name'),
    Meal.find({ restaurant: req.restaurant._id }).sort('-createdAt'),
    limitInfo(req),
  ]);
  res.json({ categories, meals, limit });
}));

/* Categories — ownership always scoped by req.restaurant */
r.post('/categories', validate(z.object({ name: z.string().min(1).max(60) })), wrap(async (req, res) => {
  res.status(201).json(await Category.create({ restaurant: req.restaurant._id, name: req.body.name }));
}));
r.patch('/categories/:id', validate(z.object({ name: z.string().min(1).max(60) })), wrap(async (req, res) => {
  const c = await Category.findOneAndUpdate({ _id: req.params.id, restaurant: req.restaurant._id }, { name: req.body.name }, { new: true });
  c ? res.json(c) : res.status(404).json({ error: 'Not found' });
}));
r.delete('/categories/:id', wrap(async (req, res) => {
  const c = await Category.findOneAndDelete({ _id: req.params.id, restaurant: req.restaurant._id });
  if (!c) return res.status(404).json({ error: 'Not found' });
  await Meal.updateMany({ restaurant: req.restaurant._id, category: c._id }, { category: null });
  res.json({ ok: true });
}));

/* Meals */
const mealSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(600).optional(),
  price: z.number().min(0).max(10_000_000),
  image: z.string().url().optional().or(z.literal('')),
  category: z.string().nullable().optional(),
  available: z.boolean().optional(),
  prepTime: z.number().int().min(0).max(600).nullable().optional(),
  portion: z.string().max(60).optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(8).optional(),
  popular: z.boolean().optional(),
  addons: z.array(z.object({
    _id: z.string().regex(/^[a-f0-9]{24}$/i).optional(), // keep ids stable so customers' saved carts keep working
    name: z.string().trim().min(1).max(80),
    price: z.number().min(0).max(1_000_000),
    group: z.string().trim().max(40).optional(),
    available: z.boolean().optional(),
  })).max(40).optional(),
});

async function checkCategory(req, id) {
  if (!id) return true;
  return !!(await Category.exists({ _id: id, restaurant: req.restaurant._id }));
}

r.post('/meals', validate(mealSchema), wrap(async (req, res) => {
  if (!(await checkCategory(req, req.body.category))) return res.status(400).json({ error: 'Invalid category' });
  const wantActive = req.body.available !== false;
  const { max, active } = await limitInfo(req);
  if (wantActive && max !== null && active >= max)
    return res.status(402).json({ error: `Free plan allows ${max} active meals. Disable a meal or upgrade to Pro.`, code: 'MEAL_LIMIT' });
  res.status(201).json(await Meal.create({ ...req.body, restaurant: req.restaurant._id }));
}));

r.patch('/meals/:id', validate(mealSchema.partial()), wrap(async (req, res) => {
  const meal = await Meal.findOne({ _id: req.params.id, restaurant: req.restaurant._id });
  if (!meal) return res.status(404).json({ error: 'Not found' });
  if (req.body.category && !(await checkCategory(req, req.body.category))) return res.status(400).json({ error: 'Invalid category' });
  if (req.body.available === true && !meal.available) {
    const { max, active } = await limitInfo(req);
    if (max !== null && active >= max) return res.status(402).json({ error: `Free plan allows ${max} active meals.`, code: 'MEAL_LIMIT' });
  }
  Object.assign(meal, req.body); await meal.save();
  res.json(meal);
}));

r.delete('/meals/:id', wrap(async (req, res) => {
  const m = await Meal.findOneAndDelete({ _id: req.params.id, restaurant: req.restaurant._id });
  m ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
}));

export default r;
